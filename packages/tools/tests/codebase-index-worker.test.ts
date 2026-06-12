/**
 * Integration test for the worker-threaded index host.
 *
 * Source-tree runs (everything else in this suite) exercise the inline
 * fallback; this file loads the BUILT package from dist, where the host
 * resolves `worker.js` next to the bundle and routes every operation through
 * the worker thread — the production configuration. Skipped when dist hasn't
 * been built yet (fresh checkout before `pnpm run build`).
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const distEntry = path.join(distDir, 'codebase-index', 'index.js');
const distWorker = path.join(distDir, 'codebase-index', 'worker.js');
const distReady = fsSync.existsSync(distEntry) && fsSync.existsSync(distWorker);

interface DistIndexApi {
  runStartupIndex(opts: {
    projectRoot: string;
    indexDir?: string;
    timeoutMs?: number;
  }): Promise<{ filesIndexed: number; symbolsIndexed: number; errors: string[] }>;
  searchCodebaseIndex(args: {
    projectRoot: string;
    indexDir?: string;
    query: string;
    limit: number;
  }): Promise<{ results: Array<{ name: string; snippet: string; score: number }>; total: number }>;
  codebaseIndexStats(args: {
    projectRoot: string;
    indexDir?: string;
  }): Promise<{ totalSymbols: number }>;
  shutdownCodebaseIndexHost(): void;
}

describe.skipIf(!distReady)('index host (worker mode, built dist)', () => {
  let api: DistIndexApi | undefined;

  afterAll(() => {
    api?.shutdownCodebaseIndexHost();
  });

  it('indexes and searches a project entirely through the worker', async () => {
    api = (await import(
      /* @vite-ignore */ `file://${distEntry.replace(/\\/g, '/')}`
    )) as unknown as DistIndexApi;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worker-'));
    const indexDir = path.join(tmpDir, '.codebase-index');
    try {
      await fs.writeFile(
        path.join(tmpDir, 'service.ts'),
        'export class PaymentService { processRefund(): void {} }',
      );

      const result = await api.runStartupIndex({
        projectRoot: tmpDir,
        indexDir,
        timeoutMs: 60_000,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(1);
      expect(result.symbolsIndexed).toBeGreaterThanOrEqual(1);

      // camelCase-split FTS match ("refund" → processRefund), ranked + snippeted.
      const found = await api.searchCodebaseIndex({
        projectRoot: tmpDir,
        indexDir,
        query: 'refund',
        limit: 10,
      });
      expect(found.results.some((r) => r.name === 'processRefund')).toBe(true);
      expect(found.results[0]?.score).toBeGreaterThan(0);

      const stats = await api.codebaseIndexStats({ projectRoot: tmpDir, indexDir });
      expect(stats.totalSymbols).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);
});
