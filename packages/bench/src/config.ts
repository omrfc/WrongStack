import * as fs from 'node:fs/promises';
import type { BenchConfig, ModelCell } from './types.js';

const DEFAULTS = {
  maxIterations: 40,
  concurrency: 4,
  timeoutMs: 600_000,
} as const;

/**
 * Parse and validate a raw `bench.config.json` object. Throws a descriptive
 * Error on any structural problem so the CLI can surface it cleanly instead of
 * failing deep inside the runner.
 */
export function parseBenchConfig(raw: unknown): BenchConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('bench config must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const cellsRaw = obj['cells'];
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) {
    throw new Error('bench config "cells" must be a non-empty array');
  }

  const seen = new Set<string>();
  const cells: ModelCell[] = cellsRaw.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new Error(`cells[${i}] must be an object`);
    }
    const cell = c as Record<string, unknown>;
    const provider = cell['provider'];
    const model = cell['model'];
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error(`cells[${i}].provider must be a non-empty string`);
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error(`cells[${i}].model must be a non-empty string`);
    }
    const label =
      typeof cell['label'] === 'string' && cell['label'].length > 0
        ? cell['label']
        : `${provider}/${model}`;
    if (seen.has(label)) {
      throw new Error(`duplicate cell label "${label}" — labels must be unique`);
    }
    seen.add(label);
    return { label, provider, model };
  });

  const maxIterations = positiveInt(obj['maxIterations'], DEFAULTS.maxIterations, 'maxIterations');
  const concurrency = positiveInt(obj['concurrency'], DEFAULTS.concurrency, 'concurrency');
  const timeoutMs = positiveInt(obj['timeoutMs'], DEFAULTS.timeoutMs, 'timeoutMs');

  return { maxIterations, concurrency, timeoutMs, cells };
}

/** Load and validate a `bench.config.json` from disk. */
export async function loadBenchConfig(path: string): Promise<BenchConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `cannot read bench config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `bench config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseBenchConfig(parsed);
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}
