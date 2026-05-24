import type { Agent, AttachmentStore, GoalFile, SlashCommandRegistry, TokenCounter } from '@wrongstack/core';
import { InputBuilder, color, goalFilePath, loadGoal } from '@wrongstack/core';
import {
  readClipboardImage,
  routeImagesForModel,
  type VisionAdapters,
} from '@wrongstack/runtime';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { getActiveSDDContext, trySaveSpecFromAIOutput, trySaveTasksFromAIOutput, getTaskListText, getTaskProgress, autoDetectTaskCompletion, getActiveSDDPhase, trySaveImplementationPlan, renderTaskListWithProgress, getCurrentTask, getCurrentExecutingContext, advanceToNextTask } from './slash-commands/sdd.js';
import { theme } from './theme.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

export interface ReplOptions {
  agent: Agent;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  banner?: boolean;
  tokenCounter?: TokenCounter;
  visionAdapters?: VisionAdapters;
  /** Autonomy mode state getter. */
  getAutonomy?: () => import('./slash-commands/autonomy.js').AutonomyMode;
  /** Set autonomy mode (used by SIGINT handler to flip back to 'off'). */
  onAutonomy?: (mode: import('./slash-commands/autonomy.js').AutonomyMode) => void;
  /**
   * Access the eternal-autonomy engine. When autonomy mode is 'eternal'
   * the REPL skips reading user input and instead drives engine
   * iterations from this loop — so the engine and the REPL never compete
   * for the shared Context. Returns null until /autonomy eternal primes it.
   */
  getEternalEngine?: () => import('@wrongstack/core').EternalAutonomyEngine | null;
  /**
   * Access the parallel-eternal engine. When autonomy mode is 'eternal-parallel'
   * the REPL drives this engine instead of reading user input.
   * Returns null until /autonomy parallel primes it.
   */
  getParallelEngine?: () => import('@wrongstack/core').ParallelEternalEngine | null;
  /** Model-specific max context window (tokens). Used for the context bar in turn summaries. */
  effectiveMaxContext?: number;
  /** Project / folder name shown in the banner. Usually `path.basename(projectRoot)`. */
  projectName?: string;
  /** Absolute project root — used to locate .wrongstack/goal.json for the goal banner. */
  projectRoot?: string;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: () => boolean | Promise<boolean>;
  /** Skill loader for the skill generator wizard. */
  skillLoader?: import('@wrongstack/core').SkillLoader;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer, opts.projectName);
  // Surface active goal + crash-recovery hint right under the banner so the
  // user doesn't have to run /goal status to remember what's in flight.
  await renderGoalBanner(opts);

  // Per-iteration abort controller — assigned each loop so a Ctrl+C that
  // cancels turn N doesn't leak into turn N+1. `activeCtrl` is updated
  // before each agent.run so the SIGINT handler can target it.
  let activeCtrl: AbortController | undefined;
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts >= 2) {
      opts.renderer.writeWarning('Exiting.');
      process.exit(130);
    }
    // In eternal or parallel mode, the first Ctrl+C should stop the engine —
    // aborting the in-flight agent.run and flipping autonomy back to 'off'
    // so the outer for-loop returns to reading user input on the next tick.
    if (
      opts.getAutonomy?.() === 'eternal' || opts.getAutonomy?.() === 'eternal-parallel'
    ) {
      opts.getEternalEngine?.()?.stop();
      opts.getParallelEngine?.()?.stop();
      opts.onAutonomy?.('off');
      opts.renderer.writeWarning('Engine stop requested. Press Ctrl+C again to exit.');
      interrupts = 0;
      return;
    }
    if (activeCtrl) {
      activeCtrl.abort();
      opts.renderer.writeWarning('Iteration cancelled. Press Ctrl+C again to exit.');
    } else {
      opts.renderer.writeWarning('Press Ctrl+C again to exit.');
    }
  };
  process.on('SIGINT', onSigint);

  const builder = new InputBuilder({ store: opts.attachments });

  // Wrap the entire loop so SIGINT and reader teardown run on every exit
  // path — exceptions, EOF, breakouts. Previously a throw between `on`
  // and the final `off` left the listener installed across REPL restarts.
  try {
    for (;;) {
      // ── Eternal autonomy: drive the engine instead of reading input. ──
      // While autonomy mode is 'eternal' we own the REPL turn — the engine
      // generates its own directive and runs `agent.run` for us. Stop is
      // signaled by the engine flipping to 'stopped' (via /autonomy stop or
      // SIGINT). On exit from this branch the for-loop continues normally
      // and the next iteration reads user input again.
      if (opts.getAutonomy?.() === 'eternal') {
        const engine = opts.getEternalEngine?.();
        if (!engine) {
          opts.renderer.writeWarning('Eternal mode set but no engine wired — falling back to off.');
          // Best-effort: nothing more to do here; the engine controller
          // was supposed to be primed by /autonomy eternal.
        } else {
          // Snapshot iteration counter before/after so the log line tells
          // the user where they are in the goal lifetime — useful when
          // the loop runs for hours and the journal scrolls off screen.
          const beforeGoal = await loadGoalSafe(opts);
          const beforeIter = beforeGoal?.iterations ?? 0;
          opts.renderer.write(
            color.dim(`\n  ↳ [eternal #${beforeIter + 1}] running iteration…\n`),
          );
          interrupts = 0;
          try {
            const ok = await engine.runOneIteration();
            const afterGoal = await loadGoalSafe(opts);
            const last = afterGoal?.journal[afterGoal.journal.length - 1];
            if (!ok && !last) {
              opts.renderer.write(color.dim('  ↳ [eternal] iteration produced no progress.\n'));
            } else if (last) {
              const mark = last.status === 'success' ? color.green('✓') : last.status === 'failure' ? color.red('✗') : color.amber('⊘');
              const tail = last.note ? color.dim(` — ${last.note.slice(0, 80)}`) : '';
              opts.renderer.write(
                `  ${mark} ${color.dim(`#${last.iteration}`)} ${color.dim(`[${last.source}]`)} ${last.task}${tail}\n`,
              );
            }
          } catch (err) {
            opts.renderer.writeError(
              `[eternal] ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // Yield to the event loop so a SIGINT delivered during this
          // iteration can be processed before the next one fires.
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      } else if (opts.getAutonomy?.() === 'eternal-parallel') {
        const engine = opts.getParallelEngine?.();
        if (!engine) {
          opts.renderer.writeWarning('Parallel mode set but no engine wired — falling back to off.');
        } else {
          const beforeGoal = await loadGoalSafe(opts);
          const beforeIter = beforeGoal?.iterations ?? 0;
          opts.renderer.write(
            color.magenta(`\n  ↳ [parallel #${beforeIter + 1}] launching fan-out…\n`),
          );
          interrupts = 0;
          try {
            const ok = await engine.runOneIteration();
            const afterGoal = await loadGoalSafe(opts);
            const last = afterGoal?.journal[afterGoal.journal.length - 1];
            if (last) {
              const mark = last.status === 'success' ? color.green('✓') : last.status === 'failure' ? color.red('✗') : color.amber('⊘');
              const tail = last.note ? color.dim(` — ${last.note.slice(0, 80)}`) : '';
              opts.renderer.write(
                `  ${mark} ${color.dim(`#${last.iteration}`)} ${color.dim(`[${last.source}]`)} ${last.task}${tail}\n`,
              );
            }
          } catch (err) {
            opts.renderer.writeError(
              `[parallel] ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }

      let raw: string;
      try {
        raw = await readPossiblyMultiline(opts);
      } catch {
        break; // EOF (Ctrl+D)
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        interrupts = 0;
        continue;
      }
      interrupts = 0;

      // Plain `q` quits immediately without needing a slash.
      if (trimmed === 'q') {
        opts.renderer.write(color.dim('  Goodbye!\n'));
        break;
      }

      if (trimmed === '/image' || trimmed === '/paste-image' || raw === '\x1bv') {
        await pasteClipboardImage(builder, opts);
        continue;
      }

      if (trimmed.startsWith('/')) {
        try {
          const res = await opts.slashRegistry.dispatch(trimmed, opts.agent.ctx);
          if (res?.message) opts.renderer.write(`${res.message}\n`);
          if (res?.exit) break;

          // ── runText: Auto-trigger AI after slash command ─────────────────
          // When a slash command returns runText (e.g. /sdd new, /sdd approve),
          // automatically send it to the AI agent so the conversation continues
          // without the user having to type anything extra.
          if (res?.runText) {
            const runBlocks = [{ type: 'text' as const, text: res.runText }];
            const runCtrl = new AbortController();
            activeCtrl = runCtrl;
            try {
              const runResult = await opts.agent.run(runBlocks, { signal: runCtrl.signal });
              if (runResult.status === 'done' && runResult.finalText) {
                // SDD auto-detection: spec, implementation plan, tasks
                const specSaved = await trySaveSpecFromAIOutput(runResult.finalText);
                if (specSaved) {
                  opts.renderer.write(
                    `\n${color.cyan('  ✓ Spec detected and saved! Use /sdd approve to continue.')}\n`,
                  );
                }
                const planSaved = trySaveImplementationPlan(runResult.finalText);
                if (planSaved) {
                  opts.renderer.write(
                    `\n${color.cyan('  ✓ Implementation plan saved!')}\n`,
                  );
                }
                const tasksSaved = await trySaveTasksFromAIOutput(runResult.finalText);
                if (tasksSaved) {
                  const progress = getTaskProgress();
                  const count = progress?.total ?? 0;
                  opts.renderer.write(
                    `\n${color.cyan(`  ✓ ${count} tasks detected and saved! Use /sdd approve to execute.`)}\n`,
                  );
                }
                // Auto-detect task completion during execution phase
                const sddPhase = getActiveSDDPhase();
                if (sddPhase === 'executing') {
                  const autoCompleted = autoDetectTaskCompletion(runResult.finalText);
                  if (autoCompleted > 0) {
                    const progress = getTaskProgress();
                    if (progress) {
                      opts.renderer.write(
                        `\n${color.cyan(`  ✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`)}\n`,
                      );
                      // Show live task list after auto-completion
                      const taskList = renderTaskListWithProgress();
                      if (taskList) {
                        opts.renderer.write(`\n${color.dim(taskList)}\n`);
                      }
                    }
                  } else {
                    // Still show task list even if nothing was auto-completed
                    const taskList = renderTaskListWithProgress();
                    if (taskList) {
                      opts.renderer.write(`\n${color.dim(taskList)}\n`);
                    }
                  }
                }
              }
            } catch (runErr) {
              // Non-fatal — user can continue manually
              opts.renderer.writeWarning('AI auto-trigger failed. You can continue manually.');
            }
          }
        } catch (err) {
          opts.renderer.writeError(err instanceof Error ? err.message : String(err));
        }
        continue;
      }

      // Route through InputBuilder so big pastes collapse to placeholders.
      const ph = await builder.appendPaste(raw);
      if (ph) {
        const lineCount = raw.split('\n').length;
        opts.renderer.write(color.dim(`  ↳ ${ph} (${lineCount} lines)\n`));
      }
      const blocks = await builder.submit();

      // ── SDD Session Integration ─────────────────────────────────────────
      // When an SDD session is active, inject the session context so the AI
      // knows to ask questions, generate specs, etc.
      const sddContext = getActiveSDDContext();
      const taskList = getTaskListText();
      const taskProgress = getTaskProgress();
      const sddPhase = getActiveSDDPhase();

      let sddPrefix = '';
      if (sddContext) {
        sddPrefix = `[SDD SESSION ACTIVE]\n${sddContext}`;
        // During executing phase: tell AI exactly which task it's working on
        if (sddPhase === 'executing') {
          const currentCtx = getCurrentExecutingContext();
          if (currentCtx) {
            sddPrefix += `\n\n${currentCtx}`;
          }
        }
        if (taskList) {
          sddPrefix += `\n\n**Current Task List:**\n${taskList}`;
        }
        if (taskProgress && taskProgress.total > 0) {
          sddPrefix += `\n**Progress:** ${taskProgress.completed}/${taskProgress.total} (${taskProgress.percentComplete}%)`;
        }
        if (sddPhase === 'executing' && taskProgress && taskProgress.percentComplete === 100) {
          sddPrefix += '\n\n**All tasks completed! Provide a summary of everything implemented.**';
        }
        sddPrefix += '\n\n---\nUser message:\n';
      }

      const effectiveBlocks = sddPrefix
        ? [
            { type: 'text' as const, text: sddPrefix },
            ...blocks,
          ]
        : blocks;

      const runCtrl = new AbortController();
      activeCtrl = runCtrl;
      try {
        const startedAt = Date.now();
        const before = opts.tokenCounter?.total();
        const costBefore = opts.tokenCounter?.estimateCost().total ?? 0;
        const routed = effectiveBlocks.some((block) => block.type === 'image')
          ? await routeImagesForModel(effectiveBlocks, {
              supportsVision: opts.supportsVision
                ? await opts.supportsVision()
                : opts.agent.ctx.provider.capabilities.vision,
              adapters: opts.visionAdapters ?? [],
              ctx: opts.agent.ctx,
              signal: runCtrl.signal,
              providerId: opts.agent.ctx.provider.id,
              model: opts.agent.ctx.model,
            })
          : { blocks: effectiveBlocks, route: 'none' as const, convertedImages: 0 };
        if (routed.route === 'adapter') {
          opts.renderer.write(
            color.dim(
              `  ↳ image analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'})\n`,
            ),
          );
        }
        const result = await opts.agent.run(routed.blocks, { signal: runCtrl.signal });
        if (result.status === 'aborted') {
          opts.renderer.writeWarning('Aborted.');
        } else if (result.status === 'failed') {
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            opts.renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
          } else {
            opts.renderer.writeError('Failed.');
          }
        } else if (result.status === 'max_iterations') {
          opts.renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }

        // ── SDD Auto-Detection ──────────────────────────────────────────
        // When an SDD session is active, auto-detect spec and task JSON
        // in the AI output and save them to the session.
        if (result.status === 'done' && result.finalText && sddContext) {
          // Try to detect and save a spec
          const specSaved = await trySaveSpecFromAIOutput(result.finalText);
          if (specSaved) {
            opts.renderer.write(
              `\n${color.cyan('  ✓ Spec detected and saved! Use /sdd approve to continue.')}\n`,
            );
          }

          // Try to save implementation plan (text before task JSON)
          const planSaved = trySaveImplementationPlan(result.finalText);
          if (planSaved) {
            opts.renderer.write(
              `\n${color.cyan('  ✓ Implementation plan saved!')}\n`,
            );
          }

          // Try to detect and save tasks
          const tasksSaved = await trySaveTasksFromAIOutput(result.finalText);
          if (tasksSaved) {
            const progress = getTaskProgress();
            const count = progress?.total ?? 0;
            opts.renderer.write(
              `\n${color.cyan(`  ✓ ${count} tasks detected and saved! Use /sdd approve to execute.`)}\n`,
            );
          }

          // Auto-detect task completion during execution phase
          const phase = getActiveSDDPhase();
          if (phase === 'executing') {
            const autoCompleted = autoDetectTaskCompletion(result.finalText);
            if (autoCompleted > 0) {
              const progress = getTaskProgress();
              if (progress) {
                opts.renderer.write(
                  `\n${color.cyan(`  ✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`)}\n`,
                );
                if (progress.percentComplete === 100) {
                  opts.renderer.write(
                    `\n${color.green('  🎉 All tasks completed! Use /sdd cancel to end the session.')}\n`,
                  );
                }
              }
              // Auto-advance: set the next ready task to in_progress
              advanceToNextTask();
              // Show updated task list after auto-advance
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            } else {
              // Still show task list even if nothing was auto-completed
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            }
          }
        }
        if (opts.tokenCounter && before) {
          const after = opts.tokenCounter.total();
          const costAfter = opts.tokenCounter.estimateCost().total;
          const ctxChip =
            opts.effectiveMaxContext && opts.effectiveMaxContext > 0
              ? `  ctx: ${renderContextChip(after.input, opts.effectiveMaxContext)}`
              : '';
          opts.renderer.write(
            `\n${color.dim(
              `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]${ctxChip}`,
            )}\n`,
          );
        }

        // Autonomy loop: after a successful run, if autonomy is active,
        // ask the agent to suggest next steps and optionally auto-continue.
        if (result.status === 'done' && opts.getAutonomy) {
          const autonomy = opts.getAutonomy();
          if (autonomy === 'auto') {
            // Self-driving: ask the agent to continue with the next logical step.
            const nextPrompt =
              'Based on what you just did, what is the single most important next step? ' +
              'Just do it — execute the next logical step without asking for confirmation. ' +
              'If there is nothing meaningful left to do, say "DONE" and nothing else.';
            opts.renderer.write(color.dim('\n  ↳ [autonomy] continuing…\n'));
            const nextBlocks = [{ type: 'text' as const, text: nextPrompt }];
            const nextCtrl = new AbortController();
            activeCtrl = nextCtrl;
            try {
              const nextResult = await opts.agent.run(nextBlocks, { signal: nextCtrl.signal });
              if (nextResult.status === 'done' && nextResult.finalText?.trim() === 'DONE') {
                opts.renderer.write(color.dim('\n  ↳ [autonomy] agent reports task complete.\n'));
              }
              // Loop continues — the for(;;) will read next input, but since
              // we're in auto mode, we need to re-trigger. We use a flag.
              if (opts.getAutonomy() === 'auto' && nextResult.status === 'done') {
                // Re-trigger: the outer loop will continue and we'll hit this
                // block again on the next iteration. But we need user input...
                // Instead, we just continue the loop with the next prompt.
              }
            } catch (err) {
              opts.renderer.writeError(
                `[autonomy] ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              activeCtrl = undefined;
            }
          } else if (autonomy === 'suggest') {
            // Suggest mode: ask the agent what to do next, show to user.
            const suggestPrompt =
              'Based on what you just did, suggest 3 concrete next steps. ' +
              'Format: numbered list, one line each, no explanation. ' +
              'If there is nothing meaningful left, say "No further steps needed."';
            const suggestBlocks = [{ type: 'text' as const, text: suggestPrompt }];
            const suggestCtrl = new AbortController();
            activeCtrl = suggestCtrl;
            try {
              const suggestResult = await opts.agent.run(suggestBlocks, { signal: suggestCtrl.signal });
              if (suggestResult.status === 'done' && suggestResult.finalText) {
                opts.renderer.write(
                  `\n${color.cyan('  Suggested next steps:')}\n${suggestResult.finalText}\n`,
                );
              }
            } catch {
              // Silently skip suggestion errors
            } finally {
              activeCtrl = undefined;
            }
          }
        }
      } catch (err) {
        opts.renderer.writeError(err instanceof Error ? err.message : String(err));
      } finally {
        activeCtrl = undefined;
      }
    }

    return 0;
  } finally {
    // Ensure listener + reader cleanup happens on every exit path: normal
    // EOF, /quit, an uncaught throw, etc. Without this, a thrown exception
    // mid-loop would leave the SIGINT handler attached for the rest of
    // the process lifetime (and the reader's terminal handle open).
    process.off('SIGINT', onSigint);
    await opts.reader.close().catch(() => {
      /* best-effort */
    });
  }
}

async function pasteClipboardImage(builder: InputBuilder, opts: ReplOptions): Promise<void> {
  try {
    const img = await readClipboardImage();
    if (!img) {
      opts.renderer.write(color.dim('  no image on clipboard\n'));
      return;
    }
    const placeholder = await builder.appendImage(img.base64, img.mediaType);
    const kb = (img.bytes / 1024).toFixed(0);
    opts.renderer.write(color.dim(`  ↳ ${placeholder} (PNG ${kb}KB)\n`));
  } catch (err) {
    opts.renderer.writeError(
      `Clipboard image error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the persisted goal file safely. Returns null on any error so the
 * REPL never crashes because /goal infrastructure is missing.
 */
async function loadGoalSafe(opts: ReplOptions): Promise<GoalFile | null> {
  if (!opts.projectRoot) return null;
  try {
    return await loadGoal(goalFilePath(opts.projectRoot));
  } catch {
    return null;
  }
}

/**
 * Print a one-line status banner about the active goal — only when a
 * goal file exists. If the previous session left the engine in 'running'
 * state, prompt the user (y/N) to resume eternal mode directly so they
 * don't have to retype the slash command. Default is N (safe path) — a
 * stray Enter after an unexpected crash shouldn't auto-burn tokens.
 */
async function renderGoalBanner(opts: ReplOptions): Promise<void> {
  const goal = await loadGoalSafe(opts);
  if (!goal) return;
  const summary = goal.goal.length > 80 ? `${goal.goal.slice(0, 77)}…` : goal.goal;
  opts.renderer.write(
    color.dim('Goal: ') + color.bold(summary) + color.dim(`  (iter ${goal.iterations})`) + '\n',
  );
  if (goal.engineState === 'running') {
    opts.renderer.write(
      color.amber('  ↺ Eternal engine was running when last session ended.') + '\n',
    );
    // Try an interactive y/N prompt. If reader is unavailable or throws
    // (non-TTY, redirected stdin, etc.) fall back to the static hint.
    try {
      const answer = (await opts.reader.readLine(color.dim('  Resume eternal mode? [y/N] ')))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        // Dispatch /autonomy eternal as if the user typed it. Routes
        // through the normal slash path so YOLO force-on, prime(), banner
        // semantics all kick in consistently.
        try {
          await opts.slashRegistry.dispatch('/autonomy eternal', opts.agent.ctx);
        } catch (err) {
          opts.renderer.writeError(
            `Auto-resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        opts.renderer.write(
          color.dim('  Not resuming. Use `/autonomy eternal` later to continue.') + '\n',
        );
      }
    } catch {
      // Non-interactive path: just hint.
      opts.renderer.write(
        color.dim('  Use `/autonomy eternal` to resume.') + '\n',
      );
    }
  }
  opts.renderer.write('\n');
}

/**
 * Read a line, but support two multiline patterns:
 *   1. Trailing `\` → continue on the next line (shell-style line continuation).
 *   2. A line that is exactly `"""` → start a heredoc; keep reading until
 *      another bare `"""`. Useful for pasting code snippets.
 * Returns the assembled text and whether it came from a heredoc block (so
 * the caller can decide to always collapse heredocs as pastes).
 */
async function readPossiblyMultiline(opts: ReplOptions): Promise<string> {
  const firstPrompt = theme.primary('› ');
  const contPrompt = color.dim('· ');
  const first = await opts.reader.readLine(firstPrompt);

  if (first.trim() === '"""') {
    const parts: string[] = [];
    try {
      for (;;) {
        const next = await opts.reader.readLine(contPrompt);
        if (next.trim() === '"""') break;
        parts.push(next);
      }
    } catch {
      // EOF (Ctrl+D) during heredoc — user typed """ then quit.
      // Return what we have; the outer catch breaks the main loop.
      return parts.join('\n');
    }
    return parts.join('\n');
  }

  let buf = first;
  while (buf.endsWith('\\')) {
    buf = buf.slice(0, -1); // drop the trailing backslash
    const cont = await opts.reader.readLine(contPrompt);
    buf += '\n' + cont;
  }
  return buf;
}

const FILLED = '█';
const EMPTY = '░';

function renderContextChip(used: number, max: number): string {
  const ratio = Math.max(0, Math.min(1, used / max));
  const pct = Math.round(ratio * 100);
  const bar = renderProgress(ratio, 6);
  return `${bar} ${pct}% (${fmtTok(used)}/${fmtTok(max)})`;
}

function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function printBanner(renderer: TerminalRenderer, projectName?: string): void {
  const lines = [
    theme.primary(theme.bold('WrongStack')) + color.dim(` v${CLI_VERSION}`),
    color.dim('Built on the wrong stack. Shipped anyway.'),
  ];
  if (projectName && projectName.length > 0) {
    lines.push(color.dim('Project: ') + theme.bold(projectName));
  }
  lines.push(color.dim('Type /help for commands, /exit or q to quit.'), '');
  renderer.write(`${lines.join('\n')}\n`);
}
