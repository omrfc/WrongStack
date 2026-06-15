import { useCallback, useEffect, useRef } from 'react';
import { useGitInfoStore } from '@/stores';
import { useWebSocket } from './useWebSocket';

/** Polls `git.info` from the server every 30 seconds while the workspace
 *  is active, so the dock chip stays fresh without hammering the server. */
export function useGitInfo() {
  const info = useGitInfoStore((s) => s.info);
  const { client } = useWebSocket();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(() => {
    // client is the WrongStackWebSocketClient instance returned by useWebSocket()
    client?.getGitInfo?.();
  }, [client]);

  // Initial fetch + polling every 30s
  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(fetch, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetch]);

  return info;
}
