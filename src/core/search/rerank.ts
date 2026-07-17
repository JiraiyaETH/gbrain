/**
 * v0.35.0.0+ — reranker call-site abstraction.
 *
 * Slots into hybridSearch after `dedupResults()` and before
 * `enforceTokenBudget()`. Takes the top `topNIn` candidates by current RRF
 * order, sends them to `gateway.rerank()`, and re-orders by the
 * cross-encoder's relevance score. The un-reranked long tail keeps its
 * original RRF order — preserves recall vs. truncating to topNIn.
 *
 * Fail-open posture: every error class (auth, network, timeout, rate-limit,
 * payload-too-large, unknown) logs to the rerank-audit JSONL and returns
 * the original RRF order unchanged. Search reliability beats reranker
 * quality; a flaky upstream must never break search.
 *
 * Caller (hybridSearch) decides whether the reranker fires via
 * `opts.reranker?.enabled`. Mode-bundle resolution defaults this to `true`
 * for tokenmax and `false` for conservative/balanced.
 */

import { createHash } from 'crypto';
import type { SearchResult } from '../types.ts';
import { rerank as gatewayRerank, RerankError, type RerankInput, type RerankResult } from '../ai/gateway.ts';
import { logRerankFailure, type RerankFailureReason } from '../rerank-audit.ts';

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, gateway uses configured default. */
  model?: string;
  /** Per-call timeout in ms (default 5000 — propagates to gateway.rerank). */
  timeoutMs?: number;
  /**
   * Test seam — when set, applyReranker calls this instead of gateway.rerank.
   * Production must NEVER set this.
   */
  rerankerFn?: (input: RerankInput) => Promise<RerankResult[]>;
}

/** SHA-256 prefix (8 chars) of the query text for privacy-preserving audit. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

const MAX_RERANK_ATTEMPTS = 2;

function validateCompleteRerank(
  value: unknown,
  expected: number,
): boolean {
  if (!Array.isArray(value) || value.length !== expected) return false;
  const seen = new Set<number>();
  for (const row of value) {
    if (
      !row || typeof row !== 'object'
      || !Number.isInteger((row as RerankResult).index)
      || (row as RerankResult).index < 0
      || (row as RerankResult).index >= expected
      || !Number.isFinite((row as RerankResult).relevanceScore)
      || seen.has((row as RerankResult).index)
    ) return false;
    seen.add((row as RerankResult).index);
  }
  return seen.size === expected;
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, logs to ~/.gbrain/audit/rerank-failures-* and
 * returns the input array unmodified. Never throws.
 *
 * Empty input passes through immediately (no upstream call).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
): Promise<SearchResult[]> {
  if (!opts.enabled || results.length === 0) return results;
  // No documents to rerank when topNIn=0 — pass through (defensive; mode
  // bundles never set 0 in practice).
  if (opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);

  // Document text — chunk_text is the matched span. Fall back to title if
  // empty (shouldn't happen in practice; defensive). Empty docs would
  // confuse the reranker, but we still send them — the upstream model decides.
  const documents = head.map(r => r.chunk_text || r.title || '');

  const rerankerFn = opts.rerankerFn ?? gatewayRerank;
  let reranked: RerankResult[] | null = null;
  let failureReason: RerankFailureReason = 'unknown';
  let failureSummary = 'reranker returned incomplete or malformed score coverage';
  for (let attempt = 1; attempt <= MAX_RERANK_ATTEMPTS; attempt++) {
    try {
      const candidate = await rerankerFn({
        query,
        documents,
        timeoutMs: opts.timeoutMs,
        ...(opts.model ? { model: opts.model } : {}),
      });
      if (validateCompleteRerank(candidate, head.length)) {
        reranked = candidate;
        break;
      }
      failureReason = 'unknown';
      failureSummary = `reranker score coverage invalid (${Array.isArray(candidate) ? candidate.length : 'non-array'}/${head.length})`;
    } catch (err) {
      failureReason = err instanceof RerankError ? err.reason : 'unknown';
      failureSummary = err instanceof Error ? err.message : String(err);
      if (failureReason === 'auth' || failureReason === 'payload_too_large') break;
    }
  }
  if (!reranked) {
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason: failureReason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: failureSummary,
      });
    } catch {
      // Audit logging must never break search.
    }
    return results;
  }

  // Build the reordered head. We keep ONLY indices the reranker returned
  // (so a top_n response with fewer items than head.length naturally
  // drops the missing ones — but since we don't pass top_n by default,
  // every input gets a score).
  const seen = new Set<number>();
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      const item = head[r.index]!;
      // Stamp the reranker score onto the result so downstream callers
      // (telemetry, debug, autocut) can see the new ordering signal. Doesn't
      // replace `score` — that's RRF and other consumers may depend on it.
      item.rerank_score = r.relevanceScore;
      // v0.40.4 attribution stamp (D12=A) — rank delta. Positive means
      // rank improved (moved closer to top). new_index is the next
      // push position in reorderedHead; original index was r.index.
      item.reranker_delta = r.index - reorderedHead.length;
      reorderedHead.push(item);
    }
  }
  // Complete score coverage is validated above; retain this defensive loop
  // so a future refactor cannot silently lose recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
