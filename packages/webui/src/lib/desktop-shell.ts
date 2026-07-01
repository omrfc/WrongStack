export function detectDesktopShell(search: string, hasDesktopHost: boolean): boolean {
  if (hasDesktopHost) return true;
  try {
    return new URLSearchParams(search).get('shell') === 'desktop';
  } catch {
    return false;
  }
}

export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return detectDesktopShell(
    window.location.search,
    Boolean((window as unknown as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost),
  );
}
