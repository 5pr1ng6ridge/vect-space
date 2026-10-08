/** Message of a caught value, which may not be an `Error`. */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
