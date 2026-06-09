import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import type { Usage, StopReason } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Chimera configuration — read from config.extensions['wstack-chimera']
// ---------------------------------------------------------------------------
interface ChimeraConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  maxFiles?: number | undefined;
  maxTokens?: number | undefined;
}

interface ResolvedChimeraConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxFiles: number;
  maxTokens: number;
}

const DEFAULT_MAX_FILES = 15;
const DEFAULT_MAX_TOKENS = 4096;

function resolveConfig(cfg: ChimeraConfig, sessionProvider: string, sessionModel: string): ResolvedChimeraConfig {
  return {
    enabled: cfg.enabled !== false,
    provider: cfg.provider ?? sessionProvider,
    model: cfg.model ?? sessionModel,
    maxFiles: cfg.maxFiles ?? DEFAULT_MAX_FILES,
    maxTokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// System prompt (condensed from packages/core/skills/chimera/SKILL.md)
// ---------------------------------------------------------------------------
const CHIMERA_SYSTEM_PROMPT = `You are Chimera, a post-session code quality agent. You review files that
were ADDED or MODIFIED during an AI coding session and produce a concise,
actionable report.

RULES
1. Only review the files provided — do not expand scope.
2. Read every file before flagging an issue.
3. Be surgical — flag real bugs, not style preferences.
4. Severity-ranked: Critical > High > Medium > Low. Only report Medium+.
5. One finding per line with severity, file:line, and a one-sentence fix.

WHAT TO LOOK FOR
- Logic bugs: off-by-one, inverted condition, null deref without guard
- Type safety: \`as any\`, missing return type on export, \`!\` assertion
- Error handling: missing try/catch on async, swallowed errors
- Security: hardcoded secret, shell injection, innerHTML XSS
- Resource leaks: event listener not removed, file handle not closed
- Test gaps: new logic without corresponding test
- API design: wrong status code, missing validation, secrets in URL

REPORT FORMAT
Use this exact structure:

## 🦂 Chimera Review

### Critical (N)
1. [BUG] \`path/file.ts:42\` — description
   → fix suggestion

### High (N)
...

### Medium (N)
...

### Summary
- Files reviewed: N
- Findings: C critical, H high, M medium
- Clean files: N

If you find NOTHING worth flagging, write only:
## 🦂 Chimera Review — all clear ✅
No issues found in N changed files.`;

// ---------------------------------------------------------------------------
// Git helpers (same pattern as git-plugin.ts)
// ---------------------------------------------------------------------------
async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(15_000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], cwd);
  return r.code === 0;
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified';
}

async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  const r = await runGit(['status', '--porcelain'], cwd);
  if (r.code !== 0) return [];

  const files: ChangedFile[] = [];
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

// ---------------------------------------------------------------------------
// Provider call — same pattern as git-plugin.ts generateCommitMessageWithLLM
// ---------------------------------------------------------------------------
interface ChimeraLLMProvider {
  complete(
    req: {
      model: string;
      system?: { type: 'text'; text: string }[] | undefined;
      messages: { role: string; content: { type: 'text'; text: string }[] }[];
      maxTokens: number;
      temperature?: number | undefined;
    },
    opts: { signal: AbortSignal },
  ): Promise<{ content: unknown; model?: string | undefined; usage?: Usage | undefined }>;
}

function asLLMProvider(provider: unknown): ChimeraLLMProvider | null {
  if (provider && typeof (provider as ChimeraLLMProvider).complete === 'function') {
    return provider as ChimeraLLMProvider;
  }
  return null;
}

async function runChimeraReview(
  files: ChangedFile[],
  fileContents: Map<string, string>,
  cwd: string,
  provider: ChimeraLLMProvider,
  model: string,
  maxTokens: number,
): Promise<string | null> {
  const fileList = files.map((f) => {
    const status = f.status === 'added' ? '[ADDED]' : '[MODIFIED]';
    return `### ${status} ${f.path}`;
  }).join('\n');

  const contents = files.map((f) => {
    const content = fileContents.get(f.path) ?? '(file not readable)';
    const truncated = content.length > 80_000
      ? `${content.slice(0, 80_000)}\n\n... (file truncated at 80KB)`
      : content;
    return `\`\`\`${f.path}\n${truncated}\n\`\`\``;
  }).join('\n\n');

  const userMessage = [
    `Review the following files changed in this session at ${cwd}:`,
    '',
    fileList,
    '',
    '---',
    '',
    contents,
    '',
    '---',
    'Produce your review report now.',
  ].join('\n');

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120_000);

  try {
    const resp = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: CHIMERA_SYSTEM_PROMPT }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: userMessage }] },
        ],
        maxTokens,
        temperature: 0.2,
      },
      { signal: ac.signal },
    );
    clearTimeout(timeout);

    const raw = resp.content;
    if (Array.isArray(raw)) {
      const texts = raw
        .filter((b): b is { type: 'text'; text: string } => {
          if (typeof b !== 'object' || b === null) return false;
          return (b as { type: string }).type === 'text';
        })
        .map((b) => b.text);
      const review = texts.join('\n').trim();
      if (review.length > 0) return review;
    } else if (typeof raw === 'string') {
      return raw.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------
function buildChimeraCommand(getConfig: () => ResolvedChimeraConfig): SlashCommand {
  return {
    name: 'chimera',
    category: 'Session',
    description: 'Show or configure the Chimera post-session code review agent.',
    help: [
      '╔═══ Chimera ═══╗',
      '',
      'Post-session code quality guardian. Reviews files changed during',
      'each session and appends a quality report to chat history.',
      '',
      'Usage:',
      '  /chimera              Show current status and configuration',
      '',
      'Configuration (edit config.json):',
      '  extensions.wstack-chimera.enabled   true | false',
      '  extensions.wstack-chimera.provider  provider id (e.g. "deepseek")',
      '  extensions.wstack-chimera.model     model id (e.g. "deepseek-v4-flash")',
      '  extensions.wstack-chimera.maxFiles  max files to review (default 15)',
      '  extensions.wstack-chimera.maxTokens max output tokens (default 4096)',
      '',
      'Example config.json:',
      '  "extensions": {',
      '    "wstack-chimera": {',
      '      "provider": "deepseek",',
      '      "model": "deepseek-v4-flash"',
      '    }',
      '  }',
    ].join('\n'),
    async run() {
      const cfg = getConfig();

      const lines = [
        `🦂 Chimera — ${cfg.enabled ? 'enabled' : 'disabled'}`,
        '',
        `  Provider:  ${cfg.provider}`,
        `  Model:     ${cfg.model}`,
        `  Max files: ${cfg.maxFiles}`,
        `  Max tokens: ${cfg.maxTokens}`,
        '',
        cfg.enabled
          ? 'Chimera will review changed files after each session ends.'
          : 'Set extensions.wstack-chimera.enabled = true to enable.',
      ];

      return { message: lines.join('\n') };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function createChimeraPlugin(): Plugin {
  return {
    name: 'wstack-chimera',
    version: '1.0.0',
    description: 'Post-session code quality guardian — reviews changed files after each session.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      // ── Reactive config: read on setup, update on config change ──────
      const recompute = (): ResolvedChimeraConfig => {
        const raw: ChimeraConfig =
          (api.config.extensions?.['wstack-chimera'] as ChimeraConfig | undefined) ?? {};
        return resolveConfig(raw, api.config.provider, api.config.model);
      };
      let resolved = recompute();

      // React to runtime config changes
      api.onConfigChange(() => {
        const old = resolved;
        resolved = recompute();
        if (old.enabled !== resolved.enabled || old.provider !== resolved.provider || old.model !== resolved.model) {
          api.log.info(
            `[chimera] config changed — enabled=${resolved.enabled} provider=${resolved.provider} model=${resolved.model}`,
          );
        }
      });

      if (!resolved.enabled) {
        api.log.info('[chimera] disabled by config (extensions.wstack-chimera.enabled = false)');
        return;
      }

      api.log.info(
        `[chimera] loaded — provider=${resolved.provider} model=${resolved.model} maxFiles=${resolved.maxFiles}`,
      );

      // ── Register slash command ────────────────────────────────────────
      api.slashCommands.register(buildChimeraCommand(() => resolved));
      api.log.info('[chimera] /chimera command registered');

      // ── Session-ended listener (fires every session, before close) ────
      api.onEvent('session.ended', async () => {
        // Re-read config in case it changed between setup and session end
        const cfg = resolved;
        if (!cfg.enabled) return;

        const cwd = api.config.cwd ?? process.cwd();

        if (!(await isGitRepo(cwd))) {
          api.log.info('[chimera] skipped — not a git repository');
          return;
        }

        const allChanged = await getChangedFiles(cwd);

        const existing: ChangedFile[] = [];
        for (const f of allChanged) {
          if (f.path.startsWith('.wrongstack/')) continue;
          try {
            await fsp.access(path.join(cwd, f.path));
            existing.push(f);
          } catch {
            // file deleted — skip
          }
        }

        if (existing.length === 0) {
          api.log.info('[chimera] no changed files to review');
          return;
        }

        const toReview = existing.slice(0, cfg.maxFiles);
        if (existing.length > cfg.maxFiles) {
          api.log.info(
            `[chimera] limiting review to ${cfg.maxFiles} of ${existing.length} changed files`,
          );
        }

        const fileContents = new Map<string, string>();
        for (const f of toReview) {
          try {
            const absPath = path.join(cwd, f.path);
            const content = await fsp.readFile(absPath, 'utf8');
            fileContents.set(f.path, content);
          } catch {
            // skip unreadable files
          }
        }

        if (fileContents.size === 0) {
          api.log.info('[chimera] could not read any changed files');
          return;
        }

        // Create chimera provider from reactive config
        let llmProvider: ChimeraLLMProvider | null = null;
        try {
          const providerCfg: Record<string, unknown> = {
            type: cfg.provider,
            model: cfg.model,
          };
          if (api.config.apiKey) providerCfg.apiKey = api.config.apiKey;
          if (api.config.baseUrl) providerCfg.baseUrl = api.config.baseUrl;
          const providerSection = api.config.providers?.[cfg.provider];
          if (providerSection) Object.assign(providerCfg, providerSection);

          const rawProvider = api.providers.create(
            providerCfg as { type: string } & Record<string, unknown>,
          );
          llmProvider = asLLMProvider(rawProvider);
        } catch (err) {
          api.log.warn(
            `[chimera] failed to create provider "${cfg.provider}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!llmProvider) {
          api.log.warn('[chimera] no usable provider — review skipped');
          return;
        }

        api.log.info(`[chimera] reviewing ${fileContents.size} file(s) with ${cfg.provider}/${cfg.model}...`);
        const reviewText = await runChimeraReview(
          toReview,
          fileContents,
          cwd,
          llmProvider,
          cfg.model,
          cfg.maxTokens,
        );

        if (!reviewText) {
          api.log.warn('[chimera] review call returned no content');
          return;
        }

        const ts = new Date().toISOString();
        try {
          await api.session.append({
            type: 'llm_response',
            ts,
            content: [{ type: 'text', text: reviewText }],
            stopReason: 'end_turn' as StopReason,
            usage: { input: 0, output: 0 },
          });
          api.log.info(`[chimera] review appended to session (${reviewText.length} chars)`);
        } catch (err) {
          api.log.warn(
            `[chimera] failed to write review: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      api.log.info('[chimera] session.ended listener registered');
    },

    teardown(api) {
      api.slashCommands.unregister('chimera');
      api.log.info('[chimera] unloaded');
    },

    async health() {
      return { ok: true, message: 'chimera ready' };
    },
  };
}
