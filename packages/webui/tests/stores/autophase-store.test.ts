import { afterEach, describe, expect, it } from 'vitest';
import { useAutoPhaseStore } from '../../src/stores/autophase-store';

describe('auto phase store', () => {
  afterEach(() => {
    useAutoPhaseStore.setState({
      phases: [],
      activePhaseId: null,
      overallPercent: 0,
      autonomous: false,
      title: null,
    });
  });

  it('setState patches each field individually', () => {
    useAutoPhaseStore.getState().setState({ phases: [{ id: 'p1', label: 'Thinking', status: 'active' }] });
    expect(useAutoPhaseStore.getState().phases).toHaveLength(1);
  });

  it('setState preserves unspecified fields', () => {
    useAutoPhaseStore.setState({ phases: [{ id: 'p1', label: 'Thinking', status: 'active' }], autonomous: true });
    useAutoPhaseStore.getState().setState({ title: 'My Title' });
    // autonomous should still be true (not reset)
    expect(useAutoPhaseStore.getState().title).toBe('My Title');
    expect(useAutoPhaseStore.getState().autonomous).toBe(true);
  });

  it('clear resets all fields', () => {
    useAutoPhaseStore.setState({
      phases: [{ id: 'p1', label: 'Thinking', status: 'active' }],
      activePhaseId: 'p1',
      overallPercent: 50,
      autonomous: true,
      title: 'Test',
    });
    useAutoPhaseStore.getState().clear();
    const s = useAutoPhaseStore.getState();
    expect(s.phases).toEqual([]);
    expect(s.activePhaseId).toBeNull();
    expect(s.overallPercent).toBe(0);
    expect(s.autonomous).toBe(false);
    expect(s.title).toBeNull();
  });
});
