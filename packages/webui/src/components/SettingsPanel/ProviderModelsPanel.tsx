/**
 * `<ProviderModelsPanel>` — provider-row expansion that surfaces the
 * picked model id and a "Refresh from server" button that re-runs
 * the health probe and re-renders the model list inline.
 *
 * Reachable from `<ProviderSection>` when a saved provider is
 * selected. The panel owns its own refresh state — multiple panels
 * can coexist in the page (one per provider) and refresh
 * independently.
 *
 * No `@/components/ui` deps — this panel uses the same raw-span
 * pattern as the surrounding `ProviderSection` for visual consistency.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WrongStackWebSocketClient } from '../../lib/ws-client';
import type { WSServerMessage } from '../../types';
import { toast } from '../Toaster';
import { Button } from '../ui/button';
import { ClearAllowlistDialog } from './ClearAllowlistDialog';
import {
  type RefreshState,
  formatClearAllowlistToast,
  formatProbeResult,
  initialRefreshState,
  projectProbe,
  selectModelList,
  selectPickedModelId,
  shouldFireUndoToast,
  shouldOfferClear,
  shouldOfferSave,
} from './ProviderModelsPanel.filter';
import { resolveUndoSend } from './undo-send-decision';

export interface ProviderModelsPanelProps {
  /** The saved provider id — used for the WS request and panel keying. */
  providerId: string;
  /**
   * The model id currently pinned for this provider, derived from
   * `cfg.models[0]` (and surfaced in `providers.saved`).
   */
  savedPickedModelId?: string | undefined;
  /**
   * The full saved allowlist (the same data the model picker uses).
   */
  savedModels?: string[] | undefined;
  /** WebSocket client used to send `provider.probe` and listen for the reply. */
  ws: WrongStackWebSocketClient;
  /**
   * Optional callback fired when the user clicks "Use" on a probed
   * model id. The page can persist the choice by sending a follow-up
   * `provider.add` (overwriting the allowlist) or by routing the user
   * to the CLI (`wstack auth local --model <id>`).
   */
  onPickModel?: ((providerId: string, modelId: string) => void) | undefined;
  /**
   * Optional callback fired when the user clicks "Clear allowlist"
   * AND confirms in the confirmation dialog. The default behavior
   * (when omitted) is to call `ws.clearProviderModels(providerId)`
   * directly. Pages that need to centralize the WS traffic (e.g. for
   * batched optimistic updates, analytics, or the undo toast) can
   * override this.
   */
  onClearModels?: ((providerId: string) => void) | undefined;
  /**
   * Optional callback fired when the user clicks the "Undo" button
   * on the toast that appears after clearing. The panel captures
   * the previous `savedModels` at confirm time and passes it here
   * so the parent can reapply it. The default behavior (when
   * omitted) is to call `ws.undoProviderClear(providerId, previousModels)`
   * — the dedicated `provider.undo_clear` message type that pairs
   * with `provider.clear_models` in the WS protocol. Pages that
   * need a custom undo (e.g. routing through a different store)
   * can override this.
   */
  onUndoClear?:
    | ((providerId: string, previousModels: string[]) => void)
    | undefined;
}

const PROBE_TIMEOUT_MS = 3_000;

export function ProviderModelsPanel({
  providerId,
  savedPickedModelId,
  savedModels,
  ws,
  onPickModel,
  onClearModels,
  onUndoClear,
}: ProviderModelsPanelProps) {
  const [state, setState] = useState<RefreshState>(() => initialRefreshState());
  // Confirmation dialog state. Lives in the panel (not the parent) so
  // a single provider's accidental click doesn't open N modals across
  // the page. The dialog is mounted only when needed (after the user
  // clicks the "Clear allowlist" ghost button) and unmounts on close.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Listen for `provider.probe` messages addressed to this provider.
  // The WS client is a global singleton — the same message may also
  // be handled by other panels, but each only acts on its own
  // providerId.
  useEffect(() => {
    const off = ws.on('provider.probe', (msg: WSServerMessage) => {
      if (msg.type !== 'provider.probe') return;
      if (msg.payload.providerId !== providerId) return;
      setState((prev) => ({
        ...prev,
        inFlight: false,
        last: projectProbe(msg.payload),
      }));
    });
    return off;
  }, [ws, providerId]);

  const onRefresh = useCallback(() => {
    setState((prev) => ({ ...prev, inFlight: true }));
    ws.probeProvider(providerId, PROBE_TIMEOUT_MS);
  }, [ws, providerId]);

  const onUseModel = useCallback(
    (modelId: string) => {
      setState((prev) => ({ ...prev, picked: modelId }));
      onPickModel?.(providerId, modelId);
    },
    [onPickModel, providerId],
  );

  /**
   * First click on "Clear allowlist" — open the confirmation dialog.
   * The actual clear + undo-toast flow runs from `confirmClear`.
   */
  const requestClear = useCallback(() => {
    setConfirmOpen(true);
  }, []);

  const cancelClear = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  /**
   * Clear the saved `models` allowlist so the picker falls back to
   * the models.dev catalog. Optimistic: we drop the local probe's
   * `picked` state too — the user is intentionally reverting to
   * "no opinion". The `savedModels` prop is owned by the parent
   * (it'll update when the server's `providers.saved` broadcast
   * comes back) so we don't touch it here.
   *
   * Captures the previous list at confirm time so the undo toast
   * can reapply it — if we read `savedModels` lazily from the
   * closure at toast-click time, the prop will already be empty
   * (the parent's optimistic state has cleared it) and undo
   * would be a no-op.
   */
  const confirmClear = useCallback(() => {
    setConfirmOpen(false);
    const previousModels = savedModels ? [...savedModels] : [];
    setState((prev) => ({ ...prev, picked: null, last: null }));
    if (onClearModels) {
      onClearModels(providerId);
    } else {
      ws.clearProviderModels(providerId);
    }
    if (!shouldFireUndoToast(previousModels)) return;
    const undo = () => {
      // Route through the decision helper so the "skip / callback /
      // ws-default" branch is testable in isolation. The ws-default
      // path uses the dedicated `provider.undo_clear` message type
      // (not a generic `provider.update`) so the audit log
      // surfaces "user undid a clear" as a distinct event
      // category.
      const decision = resolveUndoSend({ providerId, previousModels, onUndoClear });
      switch (decision.kind) {
        case 'skip':
          return;
        case 'callback':
          onUndoClear?.(decision.providerId, decision.previousModels);
          return;
        case 'ws-default':
          ws.undoProviderClear(decision.providerId, decision.previousModels);
          return;
      }
    };
    toast.undoable(
      formatClearAllowlistToast(providerId, previousModels.length),
      undo,
    );
  }, [onClearModels, onUndoClear, ws, providerId, savedModels]);

  const pickedId = useMemo(
    () => selectPickedModelId(state, savedPickedModelId, savedModels),
    [state, savedPickedModelId, savedModels],
  );
  const modelList = useMemo(
    () => selectModelList(state, savedModels),
    [state, savedModels],
  );
  const formatted = useMemo(() => formatProbeResult(state), [state]);
  const offerSave = useMemo(
    () => shouldOfferSave(state, savedModels),
    [state, savedModels],
  );
  const offerClear = useMemo(
    () => shouldOfferClear(savedModels),
    [savedModels],
  );

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/30 px-3 py-2"
      data-provider-models-panel={providerId}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground">Using</span>
          {pickedId ? (
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-primary/10 text-primary">
              {pickedId}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground italic">
              (no model picked)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {offerClear && (
            <Button
              variant="ghost"
              size="sm"
              onClick={requestClear}
              aria-label={`Clear saved allowlist for ${providerId}`}
              data-action="clear-models"
            >
              Clear allowlist
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={state.inFlight}
            aria-label={`Refresh model list for ${providerId}`}
          >
            {state.inFlight ? 'Probing…' : 'Refresh from server'}
          </Button>
        </div>
      </div>

      <ProbeResultLine formatted={formatted} />

      {modelList.length > 0 && (
        <ul
          className="mt-2 flex flex-wrap gap-1.5"
          data-provider-models-list={providerId}
        >
          {modelList.map((id) => (
            <li key={id} className="flex items-center gap-1">
              <span
                className={
                  id === pickedId
                    ? 'text-xs font-mono px-2 py-0.5 rounded bg-primary/10 text-primary'
                    : 'text-xs font-mono px-2 py-0.5 rounded border border-border text-foreground/80'
                }
              >
                {id}
              </span>
              {id !== pickedId && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => onUseModel(id)}
                  className="text-xs h-5 px-1"
                  aria-label={`Use model ${id} for ${providerId}`}
                >
                  Use
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {offerSave && (
        <p className="mt-2 text-xs text-muted-foreground">
          Probed list differs from the saved allowlist — re-run
          <span className="font-mono"> wstack auth local --model first</span>
          to persist.
        </p>
      )}

      <ClearAllowlistDialog
        open={confirmOpen}
        providerId={providerId}
        modelCount={savedModels?.length ?? 0}
        onConfirm={confirmClear}
        onCancel={cancelClear}
      />
    </div>
  );
}

function ProbeResultLine({
  formatted,
}: {
  formatted: { text: string; tone: 'success' | 'warning' | 'error' | 'muted' };
}) {
  const toneClass =
    formatted.tone === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : formatted.tone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : formatted.tone === 'error'
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-muted-foreground';
  return (
    <p
      className={`mt-1 text-xs ${toneClass}`}
      data-probe-tone={formatted.tone}
    >
      {formatted.text}
    </p>
  );
}
