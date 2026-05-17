/**
 * Dynamic favicon helper. We don't ship a `.ico` file — the icon is built at
 * runtime as an inline SVG data URL so it can be re-rendered with or without
 * a status badge.
 *
 *   setFaviconStatus('idle')      → plain "W" mark
 *   setFaviconStatus('running')   → "W" + amber pulse dot (running indicator)
 *   setFaviconStatus('ready')     → "W" + green dot (run finished, tab hidden)
 *   setFaviconStatus('error')     → "W" + red dot (run failed, tab hidden)
 *   setFaviconStatus('attention') → "W" + yellow dot (approval needed, tab hidden)
 *
 * The status auto-resets to 'idle' on the next visibilitychange where the
 * tab becomes visible — so the badge only persists while the user is away.
 */

export type FaviconStatus = 'idle' | 'running' | 'ready' | 'error' | 'attention';

const BASE_BG = '#4f46e5'; // indigo-600, matches the topbar Zap mark.

function buildSvg(status: FaviconStatus): string {
  const badge = (() => {
    if (status === 'ready')
      return '<circle cx="50" cy="14" r="14" fill="#22c55e" stroke="#fff" stroke-width="3" />';
    if (status === 'error')
      return '<circle cx="50" cy="14" r="14" fill="#ef4444" stroke="#fff" stroke-width="3" />';
    if (status === 'running')
      return '<circle cx="50" cy="14" r="14" fill="#f59e0b" stroke="#fff" stroke-width="3" />';
    if (status === 'attention')
      return '<circle cx="50" cy="14" r="14" fill="#eab308" stroke="#fff" stroke-width="3"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite"/></circle>';
    return '';
  })();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect x="2" y="2" width="60" height="60" rx="14" fill="${BASE_BG}" />
    <text x="32" y="44" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="38" font-weight="700" fill="#fff">W</text>
    ${badge}
  </svg>`;
}

function svgToDataUrl(svg: string): string {
  // encodeURIComponent keeps the URL valid across browsers; btoa would
  // also work but breaks on non-ASCII (not a concern here, but cleaner).
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function ensureLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  return link;
}

let currentStatus: FaviconStatus = 'idle';

export function setFaviconStatus(status: FaviconStatus): void {
  currentStatus = status;
  const link = ensureLink();
  if (!link) return;
  link.href = svgToDataUrl(buildSvg(status));
}

let visibilityHookInstalled = false;

/** Install the visibilitychange listener once. When the user comes back to
 *  the tab we clear any "ready/error" badge so they don't see a stale
 *  notification dot after they've already returned. */
export function installFaviconVisibilityReset(): void {
  if (visibilityHookInstalled || typeof document === 'undefined') return;
  visibilityHookInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (currentStatus === 'ready' || currentStatus === 'error' || currentStatus === 'attention')) {
      setFaviconStatus('idle');
    }
  });
}
