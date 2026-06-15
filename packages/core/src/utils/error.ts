/**
 * Converts an unknown error value to a human-readable string.
 * Used in 40+ files across the codebase to normalize error messaging.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
