import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectCellPredictions,
  parseResolvedIds,
  writeInstancePrediction,
  writePredictionsJsonl,
} from '../src/report/predictions.js';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-preds-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('per-instance predictions round-trip', () => {
  it('writes then collects predictions for a cell', async () => {
    const predDir = path.join(dir, 'predictions');
    await writeInstancePrediction(predDir, 'opus 4.8', {
      instance_id: 'django__django-1',
      model_name_or_path: 'opus 4.8',
      model_patch: 'diff a',
    });
    await writeInstancePrediction(predDir, 'opus 4.8', {
      instance_id: 'astropy__astropy-2',
      model_name_or_path: 'opus 4.8',
      model_patch: 'diff b',
    });
    // A different cell must not bleed in.
    await writeInstancePrediction(predDir, 'gpt', {
      instance_id: 'django__django-1',
      model_name_or_path: 'gpt',
      model_patch: 'diff c',
    });

    const opus = await collectCellPredictions(predDir, 'opus 4.8');
    expect(opus).toHaveLength(2);
    expect(opus.map((p) => p.instance_id).sort()).toEqual([
      'astropy__astropy-2',
      'django__django-1',
    ]);
    expect(opus.every((p) => p.model_name_or_path === 'opus 4.8')).toBe(true);

    const gpt = await collectCellPredictions(predDir, 'gpt');
    expect(gpt).toHaveLength(1);
  });

  it('collects an empty array when a cell has no predictions', async () => {
    expect(await collectCellPredictions(path.join(dir, 'predictions'), 'unknown')).toEqual([]);
  });
});

describe('writePredictionsJsonl', () => {
  it('writes one JSON object per line in official format', async () => {
    const file = await writePredictionsJsonl(dir, 'opus', [
      { instance_id: 'a', model_name_or_path: 'opus', model_patch: 'p1' },
      { instance_id: 'b', model_name_or_path: 'opus', model_patch: 'p2' },
    ]);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ instance_id: 'a', model_patch: 'p1' });
  });
});

describe('parseResolvedIds', () => {
  it('reads the resolved_ids array shape', () => {
    const ids = parseResolvedIds({ resolved_ids: ['a', 'b'], unresolved_ids: ['c'] });
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('reads the per-instance map shape', () => {
    const ids = parseResolvedIds({ a: { resolved: true }, b: { resolved: false } });
    expect([...ids]).toEqual(['a']);
  });

  it('returns empty for unexpected input', () => {
    expect(parseResolvedIds(null).size).toBe(0);
    expect(parseResolvedIds('nope').size).toBe(0);
  });
});
