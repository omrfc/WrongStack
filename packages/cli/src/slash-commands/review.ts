import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { SlashCommand, Context } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

// ── Git helpers (minimal copy — same logic as chimera-plugin) ────────────
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(10_000), windowsHide: true });
    let stdout = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.on('error', () => resolve({ stdout, code: 1 }));
    child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
  });
}

async function getChangedFiles(cwd: string): Promise<Array<{ path: string; status: 'added' | 'modified' }>> {
  const r = await runGit(['status', '--porcelain'], cwd);
  if (r.code !== 0) return [];
  const files: Array<{ path: string; status: 'added' | 'modified' }> = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const statusCode = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim();
    if (statusCode === 'A' || statusCode === 'A ' || statusCode === ' A' || statusCode === '??') {
      files.push({ path: filePath, status: 'added' });
    } else if (statusCode.includes('M')) {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

export function buildReviewCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'review',
    category: 'Session',
    aliases: ['cr'],
    description: 'Manually trigger a Chimera code review of changed files.',
    help: [
      '╔═══ Chimera Review ═══╗',
      '',
      'Manually review files changed in this session using the',
      'Chimera subagent with full tool access (read, grep, lint).',
      '',
      'Usage:',
      '  /review              Review all changed files',
    ].join('\n'),
    async run(_args: string, ctx: Context) {
      const cwd = ctx.cwd;
      const allChanged = await getChangedFiles(cwd);
      const existing: Array<{ path: string; status: 'added' | 'modified' }> = [];
      for (const f of allChanged) {
        if (f.path.startsWith('.wrongstack/')) continue;
        try { await fsp.access(path.join(cwd, f.path)); existing.push(f); } catch { /* deleted */ }
      }

      if (existing.length === 0) {
        return { message: 'No changed files to review.' };
      }

      // Read files and emit chimera.review_needed event
      const filesWithContent: Array<{ path: string; status: 'added' | 'modified'; content: string }> = [];
      for (const f of existing.slice(0, 30)) {
        try {
          const content = await fsp.readFile(path.join(cwd, f.path), 'utf8');
          filesWithContent.push({ ...f, content });
        } catch { /* skip */ }
      }

      // Emit custom event — execution.ts picks this up
      const payload = {
        config: {
          enabled: true,
          provider: ctx.provider.id,
          model: ctx.model,
          maxFiles: 30,
          maxTokens: 4096,
        },
        cwd,
        files: filesWithContent,
      };

      opts.events.emitCustom('chimera.review_needed', payload);

      return {
        message: `🦂 Chimera review triggered for ${filesWithContent.length} file(s).\nThe review report will appear in chat history shortly.`,
      };
    },
  };
}
