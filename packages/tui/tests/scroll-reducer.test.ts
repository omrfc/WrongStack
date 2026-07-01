import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';

// Minimal state carrying just the fields the scroll reducer cases touch — the
// scroll cases only read/write scrollOffset/totalLines/viewportRows/pendingNewLines.
function scrollState(over: Partial<Record<string, number>> = {}): State {
  return {
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
    ...over,
  } as unknown as State;
}

describe('TUI scroll reducer', () => {
  it('scrollBy clamps to [0, totalLines - viewportRows]', () => {
    const base = scrollState({ totalLines: 100, viewportRows: 20 }); // maxOffset 80
    expect(reducer(base, { type: 'scrollBy', delta: 30 }).scrollOffset).toBe(30);
    expect(reducer(base, { type: 'scrollBy', delta: 999 }).scrollOffset).toBe(80);
    expect(reducer(base, { type: 'scrollBy', delta: -5 }).scrollOffset).toBe(0);
  });

  it('scrollBy down to 0 clears the pending-new-lines counter', () => {
    const s = scrollState({
      totalLines: 100,
      viewportRows: 20,
      scrollOffset: 3,
      pendingNewLines: 7,
    });
    const out = reducer(s, { type: 'scrollBy', delta: -3 });
    expect(out.scrollOffset).toBe(0);
    expect(out.pendingNewLines).toBe(0);
  });

  it('scrollPage moves by viewportRows-1', () => {
    const s = scrollState({ totalLines: 200, viewportRows: 25 });
    expect(reducer(s, { type: 'scrollPage', dir: 'up' }).scrollOffset).toBe(24);
    const mid = scrollState({ totalLines: 200, viewportRows: 25, scrollOffset: 50 });
    expect(reducer(mid, { type: 'scrollPage', dir: 'down' }).scrollOffset).toBe(26);
  });

  it('scrollToBottom pins and clears pending; scrollToTop goes to maxOffset', () => {
    const s = scrollState({
      totalLines: 100,
      viewportRows: 20,
      scrollOffset: 40,
      pendingNewLines: 9,
    });
    const bottom = reducer(s, { type: 'scrollToBottom' });
    expect(bottom.scrollOffset).toBe(0);
    expect(bottom.pendingNewLines).toBe(0);
    expect(reducer(s, { type: 'scrollToTop' }).scrollOffset).toBe(80);
  });

  it('setMeasuredLines keeps the viewport anchored while scrolled up', () => {
    // Scrolled up by 10; content grows by 5 rows → offset follows (+5) so the
    // same older rows stay visible, and pending tracks the 5 new lines.
    const s = scrollState({
      totalLines: 100,
      viewportRows: 20,
      scrollOffset: 10,
      pendingNewLines: 0,
    });
    const out = reducer(s, { type: 'setMeasuredLines', totalLines: 105 });
    expect(out.totalLines).toBe(105);
    expect(out.scrollOffset).toBe(15);
    expect(out.pendingNewLines).toBe(5);
  });

  it('setMeasuredLines while pinned (offset 0) stays pinned and follows newest', () => {
    const s = scrollState({
      totalLines: 100,
      viewportRows: 20,
      scrollOffset: 0,
      pendingNewLines: 0,
    });
    const out = reducer(s, { type: 'setMeasuredLines', totalLines: 130 });
    expect(out.scrollOffset).toBe(0);
    expect(out.pendingNewLines).toBe(0);
    expect(out.totalLines).toBe(130);
  });

  it('setMeasuredLines re-clamps offset when content shrinks (e.g. /clear)', () => {
    const s = scrollState({ totalLines: 100, viewportRows: 20, scrollOffset: 70 });
    // Content shrinks to 25 rows → maxOffset 5 → offset clamps down.
    const out = reducer(s, { type: 'setMeasuredLines', totalLines: 25 });
    expect(out.scrollOffset).toBe(5);
  });

  it('setViewportRows re-clamps the offset to the new max', () => {
    const s = scrollState({ totalLines: 100, viewportRows: 20, scrollOffset: 75 }); // maxOffset was 80
    const out = reducer(s, { type: 'setViewportRows', rows: 40 }); // maxOffset now 60
    expect(out.viewportRows).toBe(40);
    expect(out.scrollOffset).toBe(60);
  });

  it('scrollTo sets an absolute offset, clamped to [0, maxOffset]', () => {
    const base = scrollState({ totalLines: 100, viewportRows: 20 }); // maxOffset 80
    expect(reducer(base, { type: 'scrollTo', offset: 42 }).scrollOffset).toBe(42);
    expect(reducer(base, { type: 'scrollTo', offset: 999 }).scrollOffset).toBe(80);
    expect(reducer(base, { type: 'scrollTo', offset: -5 }).scrollOffset).toBe(0);
  });

  it('scrollTo 0 clears the pending-new-lines counter', () => {
    const s = scrollState({
      totalLines: 100,
      viewportRows: 20,
      scrollOffset: 9,
      pendingNewLines: 4,
    });
    const out = reducer(s, { type: 'scrollTo', offset: 0 });
    expect(out.scrollOffset).toBe(0);
    expect(out.pendingNewLines).toBe(0);
  });
});
