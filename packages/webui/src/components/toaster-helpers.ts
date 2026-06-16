/**
 * Pure helpers for the `toast` store. Extracted so the test
 * suite can verify the undo-toast payload shape without spinning
 * up React + the zustand store.
 *
 * The "undo" pattern is:
 *   - user makes a destructive change
 *   - we push a toast with a TTL of ACTION_TTL_MS (8s)
 *   - the toast carries an action button labeled "Undo"
 *   - clicking "Undo" runs the supplied `onUndo` callback and
 *     dismisses the toast
 *   - if the user lets the toast expire, the `onUndo` never runs
 *
 * The `onUndo` callback closes over the data needed to revert
 * the change. For the "Clear allowlist" flow, that's the
 * previous `models` list. The helper below builds the entry
 * shape that `useToastStore.push` expects.
 */
import type { ToastAction, ToastEntry, ToastVariant } from './Toaster';

/** Mirrors the `ACTION_TTL_MS` constant in `Toaster.tsx` so the
 *  test can pin the value down without importing a side-effecting
 *  React module. Keep in sync. */
export const ACTION_TTL_MS = 8_000;

/**
 * Build a `ToastEntry` (minus the runtime-assigned `id`) for an
 * undo toast. The default label is "Undo" but can be overridden
 * for callers that want a more specific affordance.
 */
export function buildUndoToastEntry(
  message: string,
  onUndo: () => void,
  options?: { variant?: ToastVariant; ttl?: number; label?: string },
): Omit<ToastEntry, 'id'> {
  const variant: ToastVariant = options?.variant ?? 'info';
  const ttl = options?.ttl ?? ACTION_TTL_MS;
  const label = options?.label ?? 'Undo';
  const action: ToastAction = { label, onClick: onUndo };
  return { message, variant, ttl, action };
}
