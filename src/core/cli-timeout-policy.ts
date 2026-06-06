/**
 * CLI wall-clock timeout policy.
 *
 * Only a small set of known read-only commands get CLI-level connect/dispatch
 * deadline wrapping. A user-supplied global `--timeout` should tune that
 * wrapper when it applies; it must not force unrelated commands through the
 * read-only dispatcher.
 */
export function readOnlyCommandDefaultTimeoutMs(command: string, args: string[]): number | null {
  if (command === 'search') return 30_000;
  if (command === 'sources' && (args[0] === 'list' || args[0] === undefined)) return 10_000;
  return null;
}

export function resolveReadOnlyCommandTimeoutMs(
  command: string,
  args: string[],
  userTimeoutMs: number | null,
): number | null {
  const defaultMs = readOnlyCommandDefaultTimeoutMs(command, args);
  return defaultMs === null ? null : (userTimeoutMs ?? defaultMs);
}
