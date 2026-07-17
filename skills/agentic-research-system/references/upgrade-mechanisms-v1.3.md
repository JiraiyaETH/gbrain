# Upgrade mechanisms v1.3

## Shared state and workspace

Create `.research-workspaces/<task-id>/` (or an operator-approved equivalent)
with immutable raw receipts and append-only proposal files. `evidence-state.json`
is the shared state: sources, claims, edges, gaps, verification records, and
promotion proposals. Workers can append proposals; the owning lead is the only
actor that changes judgment status or emits a promotion proposal.

## Editable research DAG

The DAG is a plan, not a decorative diagram. Each node has `id`, `kind`,
`depends_on`, `lane`, `status`, `budget`, `acceptance`, and `evidence_ids`.
After every merge the lead edits node status and dispatches only the frontier:
open nodes whose dependencies are complete, prioritized by decision impact ×
uncertainty × information gain. Cancel duplicated or superseded nodes.

## Paired lanes and parity

The aware lane receives the exact dated Brain packet. The blind lane receives no
Brain claims. Both receive the same objective, source policy, tool classes,
source cap, freshness rule, and stop criteria. Compare outputs, then run an
explicit contradiction search over claims present in either lane. Aware-only
claims are not trusted merely because Brain contains them; blind-only claims are
not novel until verified against sources and Brain.

## Verification and promotion

Temporal verification checks publication/access dates and currentness;
factual verification independently checks the claim's source body and scope.
Neither verifier sees the other's verdict before recording its evidence. A claim
moves `proposed → verified` only after direct support, provenance, freshness,
and contradiction disposition. Promotion is a proposal artifact only. Operator
approval, brain-taxonomist/schema check, dry-run diff, native GBrain write, and
readback are separate gates.

Provider neutrality and bounded budgets remain invariant: changing acquisition
providers does not change packet, ledgers, DAG, state schema, or gates.
