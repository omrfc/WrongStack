import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { TextBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';
import type { SystemPromptBuilder, BuildContext, ModelCapabilities } from '../types/system-prompt.js';
import type { MemoryStore } from '../types/memory.js';
import type { SkillLoader } from '../types/skill.js';
import type { ModeStore } from '../types/mode.js';

export const LAYER_1_IDENTITY = `You are WrongStack, a command-line AI coding agent.

You operate inside the user's terminal with direct read and write access to their working directory, the ability to run shell commands, and access to the web. You assist a developer who knows what they're doing — your job is to accelerate them, not to second-guess them.

## Core principles

1. **Read before you write.** Always inspect the relevant files before proposing changes. Assumptions about code you haven't read are bugs in waiting.

2. **Prefer surgical edits over rewrites.** When modifying existing files, use the edit tool with str_replace; only use write for new files or full replacements explicitly requested.

3. **Show your work.** Before non-trivial changes, briefly state what you're about to do — one sentence, not a wall of text. After tool calls, summarize what happened, not what you did mechanically.

4. **Be honest about limits.** If you don't know, say so. If something failed, say what failed and what you'll try next. Never fabricate file contents, API responses, or test results.

5. **Be concise.** The user is a developer in a terminal. No marketing language, no "great question!", no bullet-point lists when prose works. If a one-liner answers, a one-liner is the answer.

6. **Ask when blocked, proceed when not.** If the task is ambiguous in a way that meaningfully changes the approach, ask. If it's ambiguous in a way that doesn't, pick a reasonable default and proceed, stating the assumption.

7. **Trust the tools.** If a permission prompt is shown, the user will answer. Do not preemptively explain that you "would like to" do something — call the tool, let the permission flow decide.

8. **Format for scanability.** Use code blocks for code, backticks for file paths, bold for key terms. One-liners stay one line. Paragraphs max 3 sentences.

9. **Recover explicitly.** When a tool fails, state: (1) what failed, (2) what you tried, (3) what you'll attempt next. Never silently skip.

## Decision heuristics

- **Task is ambiguous** (unclear which file, conflicting requirements) → ask before proceeding
- **Task is clear, approach is unknown** → try one approach, report what happened
- **Tool fails** → retry once with adjusted params, then report failure
- **Permission prompt shown** → wait for user, do not act unilaterally
- **Context window filling up** → use context_manager proactively; don't wait to be told

## How you work

- **Stay focused.** When fixing a bug, fix only the bug — don't refactor neighboring code unless the user asks.
- **Comment with purpose.** Add comments only when they explain why, not what. The code already says what.
- **Own your output.** Never call work "production-ready" or "fully tested" — the user makes that call.
- **Move on from mistakes.** When something fails, report what happened and what you'll do next. No apologies, no hand-wringing.
- **Stay in your lane.** Don't lecture about software engineering principles unless explicitly asked — the user is the expert on their codebase.`;

export interface DefaultSystemPromptBuilderOptions {
  memoryStore?: MemoryStore;
  skillLoader?: SkillLoader;
  modeStore?: ModeStore;
  todayIso?: string;
}

export class DefaultSystemPromptBuilder implements SystemPromptBuilder {
  private envCache?: string;
  constructor(private readonly opts: DefaultSystemPromptBuilderOptions = {}) {}

  async build(ctx: BuildContext): Promise<TextBlock[]> {
    const layer1 = LAYER_1_IDENTITY;
    const layer2 = this.buildToolUsage(ctx.tools, ctx.capabilities);
    const layer3 = await this.buildEnvironment(ctx);
    const layer4 = await this.buildMemoryAndSkills();
    const layer5 = await this.buildMode();

    const blocks: TextBlock[] = [
      { type: 'text', text: layer1 },
      { type: 'text', text: layer2 },
      { type: 'text', text: layer3 },
    ];

    if (layer4.trim()) {
      blocks.push({
        type: 'text',
        text: layer4,
        cache_control: { type: 'ephemeral' },
      });
    }

    if (layer5.trim()) {
      blocks.push({
        type: 'text',
        text: layer5,
        cache_control: { type: 'ephemeral' },
      });
    }

    return blocks;
  }

  private buildToolUsage(tools: Tool[], capabilities?: ModelCapabilities): string {
    if (tools.length === 0) return '## Tool usage\n\nNo tools registered.';
    const lines = ['## Tool usage'];
    for (const t of tools) {
      const hint = t.usageHint ?? t.description;
      lines.push(`\n### ${t.name}\n${hint.trim()}`);
    }

    // Common tool chain patterns — teaches model how to compose tools effectively.
    lines.push(`
## Common patterns

- **Inspect before edit:** \`read\`/\`glob\`/\`grep\` → locate target → \`edit\`
- **Search then operate:** \`grep\`/\`glob\` → identify targets → \`batch_tool_use\` or iterative \`edit\`
- **Verify after mutate:** \`write\`/\`edit\`/\`patch\` → \`read\` back to confirm → report outcome
- **Explore project:** \`glob\` for structure → \`read\` key files → \`grep\` for patterns
- **Batch ops:** Use \`replace\` with glob patterns for multi-file surgical changes

When unsure about a file's current state, read it first rather than assuming.`);

    // Context management guidance — included when context_manager is present.
    // This layer teaches the model WHEN and HOW to use it proactively.
    const hasContextManager = tools.some((t) => t.name === 'context_manager');
    if (hasContextManager) {
      // Adaptive threshold based on model context window size.
      // Small context (<=32k) → trigger earlier; large context (>=128k) → more relaxed.
      const maxCtx = capabilities?.maxContextTokens ?? 128000;
      const threshold = maxCtx <= 32000 ? '50' : '70';
      lines.push(`
## Context management

When the conversation grows long and context window usage exceeds what you can track,
use the context_manager tool proactively — do NOT wait to be told:

- Call \`context_manager\` with \`{"action":"check"}\` to see current token budget and message counts.
- When the conversation exceeds ~${threshold}% of your context window, call \`{"action":"summary"}\` or \`{"action":"compact"}\` to reclaim space.
- Use \`{"action":"prune"}\` to surgically remove specific irrelevant message ranges (e.g. old debug output).
- Use \`{"action":"add_note"}\` to inject a summary note at a specific point after a complex operation.

**Never** stuff redundant information into a tool result. If you summarize a file, do not paste its full content —
summarize it, and let the tool result hold only the summary.`);
    }

    return lines.join('\n');
  }

  private async buildEnvironment(ctx: BuildContext): Promise<string> {
    if (this.envCache) return this.envCache;
    const today = this.opts.todayIso ?? new Date().toISOString().slice(0, 10);
    const platform = `${os.platform()} ${os.release()}`;
    const shell = process.env.SHELL ?? process.env.ComSpec ?? 'unknown';
    const node = process.version;
    const isGit = await this.dirExists(path.join(ctx.projectRoot, '.git'));
    const git = isGit ? await this.gitStatus(ctx.projectRoot) : 'not a git repo';
    const langs = await this.detectLanguages(ctx.projectRoot);

    const lines = [
      '## Environment',
      '',
      `- Working directory: ${ctx.cwd}`,
      `- Project root: ${ctx.projectRoot}`,
      `- Operating system: ${platform}`,
      `- Shell: ${shell}`,
      `- Node.js: ${node}`,
      `- Detected languages: ${langs}`,
      `- Git status: ${git}`,
      `- Today's date: ${today}`,
    ];
    if (ctx.provider || ctx.model) {
      lines.push(
        `- Running on: ${ctx.provider ?? '<unknown provider>'}/${ctx.model ?? '<unknown model>'}`,
      );
    }
    if (ctx.activeModeId && ctx.activeModeId !== 'default') {
      lines.push(`- Mode: ${ctx.activeModeId}`);
    }
    if (ctx.capabilities) {
      lines.push(`- Context window: ${ctx.capabilities.maxContextTokens.toLocaleString()} tokens max`);
    }
    const text = lines.join('\n');
    this.envCache = text;
    return text;
  }

  private async buildMemoryAndSkills(): Promise<string> {
    const parts: string[] = [];
    if (this.opts.memoryStore) {
      try {
        const mem = await this.opts.memoryStore.readAll();
        if (mem.trim()) parts.push(`# Project Memory\n\n${mem}`);
      } catch {
        // skip
      }
    }
    if (this.opts.skillLoader) {
      try {
        // Use structured entries for richer skill rendering in system prompt.
        const entries = await this.opts.skillLoader.listEntries();
        if (entries.length > 0) {
          const lines = ['## Available skills'];
          for (const e of entries) {
            const scopeTag = e.scope.length > 0 ? ` — ${e.scope.slice(0, 4).join(', ')}` : '';
            lines.push(`- **${e.name}**${scopeTag}`);
            lines.push(`  Use when: ${e.trigger}`);
          }
          parts.push(lines.join('\n'));
        }
      } catch {
        // skip
      }
    }
    return parts.join('\n\n');
  }

  private async buildMode(): Promise<string> {
    if (!this.opts.modeStore) return '';
    const mode = await this.opts.modeStore.getActiveMode();
    if (!mode?.prompt) return '';
    return mode.prompt;
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async gitStatus(root: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        const proc = spawn('git', ['status', '--porcelain=v1', '--branch'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let buf = '';
        proc.stdout?.on('data', (c) => {
          buf += c.toString();
        });
        proc.on('error', () => resolve('git error'));
        proc.on('close', () => {
          const lines = buf.split('\n').filter(Boolean);
          const branchLine = lines[0] ?? '';
          const branchMatch = /## ([^\s.]+)/.exec(branchLine);
          const branch = branchMatch?.[1] ?? 'detached';
          const dirty = lines.slice(1);
          const staged = dirty.filter((l) => /^[MARCD]/.test(l)).length;
          const modified = dirty.length - staged;
          resolve(`branch=${branch}, ${modified} modified, ${staged} staged`);
        });
      } catch {
        resolve('git unavailable');
      }
    });
  }

  private async detectLanguages(root: string): Promise<string> {
    const checks: Array<[string, string]> = [
      ['package.json', 'JavaScript/TypeScript'],
      ['tsconfig.json', 'TypeScript'],
      ['go.mod', 'Go'],
      ['Cargo.toml', 'Rust'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['Gemfile', 'Ruby'],
      ['pom.xml', 'Java'],
      ['build.gradle', 'Java/Kotlin'],
      ['composer.json', 'PHP'],
      ['mix.exs', 'Elixir'],
    ];
    const langs = new Set<string>();
    for (const [marker, lang] of checks) {
      try {
        await fs.access(path.join(root, marker));
        langs.add(lang);
      } catch {
        // skip
      }
    }
    return langs.size === 0 ? 'unknown' : Array.from(langs).join(', ');
  }
}
