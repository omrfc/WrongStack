import { describe, expect, it } from 'vitest';
import {
  resolveSettingsFieldValue,
  SETTINGS_FIELD_LABELS,
  type SettingsPickerPatch,
} from '../src/components/settings-picker.js';

describe('resolveSettingsFieldValue', () => {
  // ── Boolean fields ──────────────────────────────────────────────

  describe('boolean fields', () => {
    const boolCases: Array<[number, string]> = [
      [3, 'yolo'],
      [5, 'chime'],
      [6, 'confirmExit'],
      [14, 'allowOutsideProjectRoot'],
      [33, 'debugStream'],
    ];

    for (const [field, _key] of boolCases) {
      const label = SETTINGS_FIELD_LABELS[field];

      it(`${label} (field ${field}): accepts on/true/yes/1`, () => {
        for (const v of ['on', 'ON', 'true', 'TRUE', 'yes', '1']) {
          const r = resolveSettingsFieldValue(field, v);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(Object.values(r.patch)[0]).toBe(true);
            expect(r.displayValue).toBe('on');
          }
        }
      });

      it(`${label} (field ${field}): accepts off/false/no/0`, () => {
        for (const v of ['off', 'OFF', 'false', 'no', '0']) {
          const r = resolveSettingsFieldValue(field, v);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(Object.values(r.patch)[0]).toBe(false);
            expect(r.displayValue).toBe('off');
          }
        }
      });

      it(`${label} (field ${field}): rejects invalid`, () => {
        const r = resolveSettingsFieldValue(field, 'maybe');
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain(label);
          expect(r.error.toLowerCase()).toContain('on');
          expect(r.error.toLowerCase()).toContain('off');
        }
      });
    }
  });

  // ── Enum fields ──────────────────────────────────────────────────

  describe('enum fields', () => {
    it('autonomy mode (0): accepts off/suggest/auto (case-insensitive)', () => {
      for (const [v, expected] of [['off', 'off'], ['SUGGEST', 'suggest'], ['Auto', 'auto']] as const) {
        const r = resolveSettingsFieldValue(0, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.mode).toBe(expected);
      }
    });

    it('autonomy mode (0): rejects invalid with valid options listed', () => {
      const r = resolveSettingsFieldValue(0, 'fast');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('off');
        expect(r.error).toContain('suggest');
        expect(r.error).toContain('auto');
      }
    });

    it('reasoning effort (24): accepts all levels', () => {
      const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      for (const v of levels) {
        const r = resolveSettingsFieldValue(24, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.reasoningEffort).toBe(v);
      }
    });

    it('log level (31): accepts all levels', () => {
      const levels = ['error', 'warn', 'info', 'debug', 'trace'];
      for (const v of levels) {
        const r = resolveSettingsFieldValue(31, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.logLevel).toBe(v);
      }
    });

    it('config scope (35): accepts global/project', () => {
      const r1 = resolveSettingsFieldValue(35, 'global');
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.patch.configScope).toBe('global');

      const r2 = resolveSettingsFieldValue(35, 'PROJECT');
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.patch.configScope).toBe('project');
    });
  });

  // ── Preset (numeric) fields ─────────────────────────────────────

  describe('preset fields', () => {
    it('max iterations (15): accepts numeric preset', () => {
      const r = resolveSettingsFieldValue(15, '500');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxIterations).toBe(500);
        expect(r.displayValue).toBe('500');
      }
    });

    it('max iterations (15): accepts "unlimited" for 0', () => {
      const r = resolveSettingsFieldValue(15, 'unlimited');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxIterations).toBe(0);
        expect(r.displayValue).toBe('unlimited');
      }
    });

    it('max iterations (15): rejects non-preset number', () => {
      const r = resolveSettingsFieldValue(15, '42');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('100');
        expect(r.error).toContain('unlimited');
      }
    });

    it('auto-proceed delay (1): accepts numeric and display name', () => {
      const r1 = resolveSettingsFieldValue(1, '30000');
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.patch.delayMs).toBe(30_000);

      const r2 = resolveSettingsFieldValue(1, '30s');
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.patch.delayMs).toBe(30_000);
    });

    it('auto-proceed delay (1): accepts "disabled" for 0', () => {
      const r = resolveSettingsFieldValue(1, 'disabled');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.delayMs).toBe(0);
        expect(r.displayValue).toBe('disabled');
      }
    });

    it('multi-diff summary (21): accepts "off" for 0', () => {
      const r = resolveSettingsFieldValue(21, 'off');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.multiDiffSummaryThreshold).toBe(0);
      }
    });

    it('max concurrent (30): accepts "runtime default" for 0', () => {
      const r = resolveSettingsFieldValue(30, 'runtime default');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxConcurrent).toBe(0);
      }
    });
  });

  // ── Text field (thinking word) ──────────────────────────────────

  describe('thinking word (22)', () => {
    it('accepts a valid word', () => {
      const r = resolveSettingsFieldValue(22, 'pondering');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.thinkingWord).toBe('pondering');
        expect(r.displayValue).toBe('pondering');
      }
    });

    it('accepts a short custom word', () => {
      const r = resolveSettingsFieldValue(22, 'brewing');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.patch.thinkingWord).toBe('brewing');
    });

    it('rejects empty string', () => {
      const r = resolveSettingsFieldValue(22, '');
      expect(r.ok).toBe(false);
    });

    it('rejects word longer than 16 chars', () => {
      const r = resolveSettingsFieldValue(22, 'supercalifragilistic');
      expect(r.ok).toBe(false);
    });

    it('rejects words with special characters', () => {
      const r = resolveSettingsFieldValue(22, 'think!');
      expect(r.ok).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns error for out-of-range field', () => {
      const r = resolveSettingsFieldValue(99, 'on');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('99');
    });

    it('SETTINGS_FIELD_LABELS has 36 entries', () => {
      expect(SETTINGS_FIELD_LABELS.length).toBe(36);
    });

    it('trims whitespace from input', () => {
      const r = resolveSettingsFieldValue(3, '  on  ');
      expect(r.ok).toBe(true);
    });

    it('all boolean field indices are covered', () => {
      const boolFields = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 18, 20, 25, 27, 33];
      for (const f of boolFields) {
        const r = resolveSettingsFieldValue(f, 'on');
        expect(r.ok).toBe(true);
      }
    });

    it('all enum field indices are covered', () => {
      const enumFields = [0, 13, 19, 23, 24, 26, 28, 29, 31, 32, 34, 35];
      for (const f of enumFields) {
        // Use the first value from SETTINGS_FIELD_LABELS to construct a dummy test
        const r = resolveSettingsFieldValue(f, 'invalid_value_xyz');
        expect(r.ok).toBe(false); // should fail, not crash
      }
    });

    it('all preset field indices are covered', () => {
      const presetFields = [1, 15, 16, 17, 21, 30];
      for (const f of presetFields) {
        const r = resolveSettingsFieldValue(f, '999999');
        expect(r.ok).toBe(false); // should fail with error, not crash
      }
    });
  });
});
