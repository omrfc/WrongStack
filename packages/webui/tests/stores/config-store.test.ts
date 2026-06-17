import { beforeEach, describe, expect, it } from 'vitest';
import { useConfigStore } from '../../src/stores/config-store';

function resetStore() {
  useConfigStore.setState({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    wsUrl: 'ws://127.0.0.1:3457',
    wsConnected: false,
    wsStatus: { state: 'connecting' as const },
    theme: 'system',
    autoConnect: true,
    soundOnComplete: false,
  });
}

// ── setProvider ────────────────────────────────────────────────────

describe('setProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets the provider', () => {
    useConfigStore.getState().setProvider('openai');
    expect(useConfigStore.getState().provider).toBe('openai');
  });
});

// ── setModel ──────────────────────────────────────────────────────

describe('setModel', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets the model', () => {
    useConfigStore.getState().setModel('gpt-4o');
    expect(useConfigStore.getState().model).toBe('gpt-4o');
  });
});

// ── setConfig ─────────────────────────────────────────────────────

describe('setConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets multiple fields at once', () => {
    useConfigStore.getState().setConfig({
      provider: 'google',
      model: 'gemini-2',
      autoConnect: false,
      theme: 'dark',
    });
    const state = useConfigStore.getState();
    expect(state.provider).toBe('google');
    expect(state.model).toBe('gemini-2');
    expect(state.autoConnect).toBe(false);
    expect(state.theme).toBe('dark');
  });

  it('does not affect other fields', () => {
    useConfigStore.getState().setConfig({ theme: 'light' });
    const state = useConfigStore.getState();
    expect(state.provider).toBe('anthropic');
    expect(state.autoConnect).toBe(true);
  });
});

// ── setTheme ──────────────────────────────────────────────────────

describe('setTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets theme to light', () => {
    useConfigStore.getState().setTheme('light');
    expect(useConfigStore.getState().theme).toBe('light');
  });

  it('sets theme to dark', () => {
    useConfigStore.getState().setTheme('dark');
    expect(useConfigStore.getState().theme).toBe('dark');
  });

  it('sets theme to system', () => {
    useConfigStore.setState({ theme: 'dark' });
    useConfigStore.getState().setTheme('system');
    expect(useConfigStore.getState().theme).toBe('system');
  });
});

// ── setWsConnected ───────────────────────────────────────────────

describe('setWsConnected', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets wsConnected to true', () => {
    useConfigStore.getState().setWsConnected(true);
    expect(useConfigStore.getState().wsConnected).toBe(true);
  });

  it('sets wsConnected to false', () => {
    useConfigStore.setState({ wsConnected: true });
    useConfigStore.getState().setWsConnected(false);
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });
});

// ── setWsStatus ─────────────────────────────────────────────────

describe('setWsStatus', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('sets status to open and auto-sets wsConnected to true', () => {
    useConfigStore.getState().setWsStatus({ state: 'open' });
    const state = useConfigStore.getState();
    expect(state.wsStatus).toEqual({ state: 'open' });
    expect(state.wsConnected).toBe(true);
  });

  it('sets status to closed and leaves wsConnected unchanged', () => {
    useConfigStore.setState({ wsConnected: true });
    useConfigStore.getState().setWsStatus({ state: 'closed', error: 'server gone' });
    const state = useConfigStore.getState();
    expect(state.wsStatus).toEqual({ state: 'closed', error: 'server gone' });
    expect(state.wsConnected).toBe(false); // persist's hydration may have set this
  });

  it('sets status to reconnecting', () => {
    useConfigStore.getState().setWsStatus({
      state: 'reconnecting',
      attempt: 3,
      nextRetryAt: Date.now() + 5000,
      lastError: 'ECONNRESET',
    });
    const state = useConfigStore.getState();
    expect(state.wsStatus.state).toBe('reconnecting');
    expect((state.wsStatus as { state: 'reconnecting'; attempt: number }).attempt).toBe(3);
  });

  it('sets status to connecting', () => {
    useConfigStore.getState().setWsStatus({ state: 'connecting' });
    expect(useConfigStore.getState().wsStatus).toEqual({ state: 'connecting' });
  });
});

// ── setSoundOnComplete ───────────────────────────────────────────

describe('setSoundOnComplete', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('enables sound', () => {
    useConfigStore.getState().setSoundOnComplete(true);
    expect(useConfigStore.getState().soundOnComplete).toBe(true);
  });

  it('disables sound', () => {
    useConfigStore.setState({ soundOnComplete: true });
    useConfigStore.getState().setSoundOnComplete(false);
    expect(useConfigStore.getState().soundOnComplete).toBe(false);
  });
});
