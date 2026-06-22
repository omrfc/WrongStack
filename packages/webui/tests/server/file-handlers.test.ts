import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// We'll test the actual implementation by creating temp directories
// and checking the output

describe('file handlers integration', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    tempDir = path.join(process.env.TEMP || '/tmp', `test-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Helper to create a mock WebSocket
  function createMockWs() {
    const ws = {
      readyState: 1,
      sent: [] as unknown[],
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
    } as never as WebSocket & { sent: unknown[] };
    return ws;
  }

  describe('handleFilesTree', () => {
    it('builds tree from project root', async () => {
      // Create some test files
      fsSync.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const x = 1;');
      fsSync.writeFileSync(path.join(tempDir, 'package.json'), '{}');

      // Import the handler
      const { handleFilesTree } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { tree: unknown[]; root: string } };
      expect(response.type).toBe('files.tree');
      expect(response.payload.root).toBe(tempDir);
      expect(Array.isArray(response.payload.tree)).toBe(true);
    });

    it('handles path outside projectRoot', async () => {
      const { handleFilesTree } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: { path: '../outside' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { error: string } };
      expect(response.payload.error).toBe('Path outside project root');
    });

    it('skips hidden files and directories', async () => {
      // Create hidden files
      fsSync.writeFileSync(path.join(tempDir, '.hidden'), 'hidden');
      fsSync.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'visible.txt'), 'visible');

      const { handleFilesTree } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { tree: unknown[] } };
      const names = (response.payload.tree as { name: string }[]).map(n => n.name);
      expect(names).not.toContain('.hidden');
      expect(names).toContain('visible.txt');
    });
  });

  describe('handleFilesRead', () => {
    it('reads file content', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      fsSync.writeFileSync(testFile, 'Hello World');

      const { handleFilesRead } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: 'test.txt' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { content: string } };
      expect(response.payload.content).toBe('Hello World');
    });

    it('returns error for path traversal', async () => {
      const { handleFilesRead } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: '../etc/passwd' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { error: string } };
      expect(response.payload.error).toBe('Forbidden');
    });

    it('returns error for non-existent file', async () => {
      const { handleFilesRead } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: 'nonexistent.txt' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { error: string } };
      expect(response.payload.error).toBeTruthy();
    });
  });

  describe('handleFilesList', () => {
    it('lists project files', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'src', 'a.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'src', 'b.ts'), '');

      const { handleFilesList } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { files: string[] } };
      expect(response.payload.files).toContain('src/a.ts');
      expect(response.payload.files).toContain('src/b.ts');
    });

    it('respects limit parameter', async () => {
      // Create many files
      for (let i = 0; i < 10; i++) {
        fsSync.writeFileSync(path.join(tempDir, `file${i}.txt`), '');
      }

      const { handleFilesList } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { limit: 3 } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: string[] } };
      expect(response.payload.files.length).toBeLessThanOrEqual(3);
    });

    it('filters by query (fuzzy search)', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'alpha.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'beta.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'gamma.ts'), '');

      const { handleFilesList } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { query: 'al' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: string[] } };
      // alpha.ts should rank higher than others for 'al' query
      expect(response.payload.files[0]).toBe('alpha.ts');
    });

    it('returns empty for path outside projectRoot', async () => {
      const { handleFilesList } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { path: '../outside' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: unknown[] } };
      expect(response.payload.files).toEqual([]);
    });
  });

  describe('handleFilesWrite', () => {
    it('writes file successfully', async () => {
      const { handleFilesWrite } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        { type: 'files.write', payload: { filePath: 'new-file.txt', content: 'test content' } },
        tempDir
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);

      // Verify file was written
      const content = fsSync.readFileSync(path.join(tempDir, 'new-file.txt'), 'utf8');
      expect(content).toBe('test content');
    });

    it('returns error for path traversal', async () => {
      const { handleFilesWrite } = await import('../../src/server/file-handlers.js');
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        { type: 'files.write', payload: { filePath: '../evil.txt', content: 'hack' } },
        tempDir
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean; error: string } };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });
  });
});
