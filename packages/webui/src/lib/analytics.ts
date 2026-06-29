import { useCallback } from 'react';

export interface AnalyticsEvent {
  event: string;
  category: string;
  label?: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

const ANALYTICS_QUEUE: AnalyticsEvent[] = [];
const MAX_QUEUE_SIZE = 100;

function enqueueEvent(event: AnalyticsEvent): void {
  ANALYTICS_QUEUE.push(event);
  if (ANALYTICS_QUEUE.length > MAX_QUEUE_SIZE) {
    ANALYTICS_QUEUE.shift();
  }
}

export function trackEvent(
  event: string,
  category: string,
  options?: {
    label?: string;
    value?: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const analyticsEvent: AnalyticsEvent = {
    event,
    category,
    label: options?.label,
    value: options?.value,
    metadata: options?.metadata,
    timestamp: new Date().toISOString(),
  };

  enqueueEvent(analyticsEvent);

  // Also log to console in development
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log('[Analytics]', analyticsEvent);
  }
}

export function useAnalytics() {
  const track = useCallback(
    (
      event: string,
      category: string,
      options?: {
        label?: string;
        value?: number;
        metadata?: Record<string, unknown>;
      },
    ) => {
      trackEvent(event, category, options);
    },
    [],
  );

  return { track };
}

export function getAnalyticsQueue(): readonly AnalyticsEvent[] {
  return [...ANALYTICS_QUEUE];
}

export function clearAnalyticsQueue(): void {
  ANALYTICS_QUEUE.length = 0;
}
