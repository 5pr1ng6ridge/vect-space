/** Human-readable text for a caught value of unknown type. */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
