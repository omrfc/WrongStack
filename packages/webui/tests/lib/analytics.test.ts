import { describe, expect, it, beforeEach } from 'vitest';
import {
  trackEvent,
  getAnalyticsQueue,
  clearAnalyticsQueue,
  type AnalyticsEvent,
} from '../../src/lib/analytics';

describe('analytics', () => {
  beforeEach(() => {
    clearAnalyticsQueue();
  });

  it('should track an event and store it in the queue', () => {
    trackEvent('test_event', 'test_category', {
      label: 'test_label',
      value: 42,
      metadata: { key: 'value' },
    });

    const queue = getAnalyticsQueue();
    expect(queue).toHaveLength(1);

    const event = queue[0] as AnalyticsEvent;
    expect(event.event).toBe('test_event');
    expect(event.category).toBe('test_category');
    expect(event.label).toBe('test_label');
    expect(event.value).toBe(42);
    expect(event.metadata).toEqual({ key: 'value' });
    expect(event.timestamp).toBeDefined();
  });

  it('should track multiple events', () => {
    trackEvent('event_1', 'category_1');
    trackEvent('event_2', 'category_2');
    trackEvent('event_3', 'category_3');

    const queue = getAnalyticsQueue();
    expect(queue).toHaveLength(3);
  });

  it('should limit queue size to MAX_QUEUE_SIZE', () => {
    // Fill the queue beyond MAX_QUEUE_SIZE (100)
    for (let i = 0; i < 105; i++) {
      trackEvent(`event_${i}`, 'category');
    }

    const queue = getAnalyticsQueue();
    expect(queue).toHaveLength(100);
    // The oldest events should have been removed
    expect(queue[0]?.event).toBe('event_5');
  });

  it('should track referral link copy events', () => {
    trackEvent('referral_link_copied', 'engagement', {
      label: 'MiniMax',
      metadata: {
        providerId: 'minimax',
        referralCode: 'ABC123',
      },
    });

    const queue = getAnalyticsQueue();
    expect(queue).toHaveLength(1);

    const event = queue[0] as AnalyticsEvent;
    expect(event.event).toBe('referral_link_copied');
    expect(event.category).toBe('engagement');
    expect(event.label).toBe('MiniMax');
    expect(event.metadata).toEqual({
      providerId: 'minimax',
      referralCode: 'ABC123',
    });
  });

  it('should clear the queue', () => {
    trackEvent('event_1', 'category');
    trackEvent('event_2', 'category');

    expect(getAnalyticsQueue()).toHaveLength(2);

    clearAnalyticsQueue();
    expect(getAnalyticsQueue()).toHaveLength(0);
  });

  it('should create immutable queue snapshots', () => {
    trackEvent('event_1', 'category');

    const queue1 = getAnalyticsQueue();
    const queue2 = getAnalyticsQueue();

    expect(queue1).toEqual(queue2);
    expect(queue1).not.toBe(queue2); // Different array instances
  });
});
