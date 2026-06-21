import { describe, expect, it } from 'vitest';
import {
  agentFanPos,
  clientNodeType,
  fmtAgo,
  fmtCompact,
  fmtUptime,
  layoutClientXs,
  mapAgentStatus,
  shortModel,
  surfaceLabel,
} from '../../src/components/OfficeMapCanvas/utils.js';

describe('OfficeMapCanvas utils', () => {
  describe('fmtCompact', () => {
    it('formats small numbers as-is', () => {
      expect(fmtCompact(0)).toBe('0');
      expect(fmtCompact(42)).toBe('42');
      expect(fmtCompact(999)).toBe('999');
    });

    it('formats thousands with k suffix', () => {
      expect(fmtCompact(1000)).toBe('1.0k');
      expect(fmtCompact(1500)).toBe('1.5k');
      expect(fmtCompact(12345)).toBe('12.3k');
    });

    it('formats millions with M suffix', () => {
      expect(fmtCompact(1_000_000)).toBe('1.0M');
      expect(fmtCompact(1_500_000)).toBe('1.5M');
    });

    it('handles undefined and non-finite', () => {
      expect(fmtCompact(undefined)).toBe('0');
      expect(fmtCompact(Number.NaN)).toBe('0');
      expect(fmtCompact(Number.POSITIVE_INFINITY)).toBe('0');
    });
  });

  describe('fmtAgo', () => {
    const now = Date.parse('2026-06-21T10:00:00Z');

    it('returns "never" for undefined or unparseable', () => {
      expect(fmtAgo(undefined, now)).toBe('never');
      expect(fmtAgo('not-a-date', now)).toBe('never');
    });

    it('formats seconds', () => {
      expect(fmtAgo('2026-06-21T09:59:30Z', now)).toBe('30s ago');
    });

    it('formats minutes', () => {
      expect(fmtAgo('2026-06-21T09:57:00Z', now)).toBe('3m ago');
    });

    it('formats hours', () => {
      expect(fmtAgo('2026-06-21T07:00:00Z', now)).toBe('3h ago');
    });

    it('formats days', () => {
      expect(fmtAgo('2026-06-19T10:00:00Z', now)).toBe('2d ago');
    });
  });

  describe('fmtUptime', () => {
    const now = Date.parse('2026-06-21T10:00:00Z');

    it('returns empty for undefined', () => {
      expect(fmtUptime(undefined, now)).toBe('');
    });

    it('formats seconds', () => {
      expect(fmtUptime('2026-06-21T09:59:30Z', now)).toBe('30s');
    });

    it('formats minutes', () => {
      expect(fmtUptime('2026-06-21T09:57:00Z', now)).toBe('3m');
    });

    it('formats hours', () => {
      expect(fmtUptime('2026-06-21T07:00:00Z', now)).toBe('3h');
    });
  });

  describe('shortModel', () => {
    it('returns undefined for empty input', () => {
      expect(shortModel(undefined)).toBeUndefined();
      expect(shortModel('')).toBeUndefined();
    });

    it('extracts the last path segment', () => {
      expect(shortModel('anthropic/claude-opus-4')).toBe('claude-opus-4');
    });

    it('truncates long names', () => {
      const result = shortModel('provider/very-long-model-name-that-exceeds-limit');
      expect(result).toHaveLength(18);
    });
  });

  describe('layoutClientXs', () => {
    it('places a single client at CENTER_X', () => {
      const map = layoutClientXs(['a']);
      expect(map.get('a')).toBe(600);
    });

    it('spreads multiple clients symmetrically', () => {
      const map = layoutClientXs(['a', 'b', 'c']);
      expect(map.get('a')).toBeLessThan(map.get('b')!);
      expect(map.get('b')).toBeLessThan(map.get('c')!);
      // Center client should be at CENTER_X
      expect(map.get('b')).toBe(600);
    });

    it('respects custom column width', () => {
      const map = layoutClientXs(['a', 'b'], 200);
      expect(map.get('b')! - map.get('a')!).toBe(200);
    });
  });

  describe('agentFanPos', () => {
    it('positions agents in a centered grid', () => {
      const pos0 = agentFanPos(600, 0, 3);
      const pos1 = agentFanPos(600, 1, 3);
      const pos2 = agentFanPos(600, 2, 3);
      expect(pos1.x).toBe(600); // middle agent centered
      expect(pos0.x).toBeLessThan(pos1.x);
      expect(pos2.x).toBeGreaterThan(pos1.x);
      expect(pos0.y).toBe(pos1.y);
      expect(pos1.y).toBe(pos2.y);
    });

    it('wraps to a new row when exceeding AGENT_COLS', () => {
      const pos2 = agentFanPos(600, 2, 6);
      const pos3 = agentFanPos(600, 3, 6);
      expect(pos3.y).toBeGreaterThan(pos2.y);
    });
  });

  describe('clientNodeType', () => {
    it('maps tui', () => {
      expect(clientNodeType('tui')).toBe('tui');
    });

    it('maps repl', () => {
      expect(clientNodeType('repl')).toBe('repl');
    });

    it('maps cli to repl', () => {
      expect(clientNodeType('cli')).toBe('repl');
    });

    it('defaults to webui', () => {
      expect(clientNodeType(undefined)).toBe('webui');
      expect(clientNodeType('webui')).toBe('webui');
    });
  });

  describe('surfaceLabel', () => {
    it('returns TUI label', () => {
      expect(surfaceLabel('tui')).toBe('TUI');
    });

    it('returns REPL label', () => {
      expect(surfaceLabel('repl')).toBe('REPL');
    });

    it('returns WebUI label', () => {
      expect(surfaceLabel('webui')).toBe('WebUI');
    });
  });

  describe('mapAgentStatus', () => {
    it('maps running to active', () => {
      expect(mapAgentStatus('running')).toBe('active');
    });

    it('maps idle', () => {
      expect(mapAgentStatus('idle')).toBe('idle');
    });

    it('maps completed', () => {
      expect(mapAgentStatus('completed')).toBe('completed');
    });

    it('maps failed to error', () => {
      expect(mapAgentStatus('failed')).toBe('error');
    });

    it('maps stopped to offline', () => {
      expect(mapAgentStatus('stopped')).toBe('offline');
    });

    it('defaults to idle for unknown', () => {
      expect(mapAgentStatus(undefined)).toBe('idle');
      expect(mapAgentStatus('unknown')).toBe('idle');
    });
  });
});
