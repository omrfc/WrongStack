import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * One SWE-bench prediction row, in the exact shape the official harness
 * (`princeton-nlp/SWE-bench`) consumes via `--predictions_path`.
 */
export interface SwebenchPrediction {
  instance_id: string;
  /** The model/system label — becomes a column in the official report. */
  model_name_or_path: string;
  /** The unified diff the agent produced. */
  model_patch: string;
}

/**
 * Write a `predictions.jsonl` for one model cell. SWE-bench grading is delegated
 * to the canonical, version-sensitive harness rather than re-implemented here:
 * we own running the agent and producing a conformant patch; the official tool
 * owns the Docker execution and pass/fail verdict.
 *
 * Returns the file path written.
 */
export async function writePredictionsJsonl(
  outDir: string,
  cellLabel: string,
  predictions: SwebenchPrediction[],
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `predictions-${slug(cellLabel)}.jsonl`);
  const body = predictions.map((p) => JSON.stringify(p)).join('\n');
  await fs.writeFile(file, body + (body ? '\n' : ''), 'utf8');
  return file;
}

/**
 * Write one instance's prediction to its own file under
 * `<predictionsDir>/<cell>/<instance>.json`. Distinct files per instance are
 * concurrency-safe — the SWE-bench grader runs inside the orchestrator's
 * parallel fan-out, so appending to a shared jsonl would race. Call
 * {@link collectCellPredictions} after the run to merge them.
 */
export async function writeInstancePrediction(
  predictionsDir: string,
  cellLabel: string,
  prediction: SwebenchPrediction,
): Promise<void> {
  const dir = path.join(predictionsDir, slug(cellLabel));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${slug(prediction.instance_id)}.json`),
    JSON.stringify(prediction),
    'utf8',
  );
}

/** Read back every per-instance prediction written for one cell. */
export async function collectCellPredictions(
  predictionsDir: string,
  cellLabel: string,
): Promise<SwebenchPrediction[]> {
  const dir = path.join(predictionsDir, slug(cellLabel));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SwebenchPrediction[] = [];
  for (const name of entries.filter((e) => e.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as SwebenchPrediction);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * Parse an official SWE-bench evaluation report JSON for the set of resolved
 * instance ids. The harness writes `resolved_ids` (newer) or a per-instance
 * `{ resolved: bool }` map; both shapes are handled so this keeps working across
 * harness versions.
 */
export function parseResolvedIds(reportJson: unknown): Set<string> {
  const resolved = new Set<string>();
  if (typeof reportJson !== 'object' || reportJson === null) return resolved;
  const obj = reportJson as Record<string, unknown>;

  if (Array.isArray(obj['resolved_ids'])) {
    for (const id of obj['resolved_ids']) if (typeof id === 'string') resolved.add(id);
    return resolved;
  }

  // Per-instance map fallback: { "<id>": { resolved: true }, ... }.
  for (const [id, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && (v as Record<string, unknown>)['resolved'] === true) {
      resolved.add(id);
    }
  }
  return resolved;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'cell'
  );
}
