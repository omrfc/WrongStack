import { type SecretVault, color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import { persistAutonomySetting } from '../settings-menu.js';
import type { SlashCommandContext } from './index.js';

const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
};

/**
 * `/enhance` — toggle prompt refinement ("did you mean this?").
 *
 * When on, free-text prompts are rewritten by a separate one-shot LLM call into
 * a clearer instruction and briefly previewed before reaching the main agent.
 * The live toggle is flipped via the shared `enhanceController` (the TUI
 * installs a dispatch-backed setter on mount); the choice is persisted to
 * `config.autonomy.enhance` so it survives restarts.
 */
export function buildEnhanceCommand(opts: SlashCommandContext): SlashCommand {
  const controller = opts.enhanceController;

  return {
    name: 'enhance',
    category: 'Config',
    description: 'Toggle prompt refinement ("did you mean this?") before sending.',
    help: [
      'Usage:',
      '  /enhance            Show current prompt-refinement status',
      '  /enhance on         Enable — refine free-text prompts before sending',
      '  /enhance off        Disable — send prompts verbatim',
      '  /enhance toggle     Flip the current state',
      '',
      'When on, each free-text message is rewritten into a clearer instruction',
      'by a separate LLM call and briefly previewed (auto-sends after a short',
      'countdown; Enter sends now, Esc keeps your original, e edits). Persisted',
      'to ~/.wrongstack/config.json (autonomy.enhance).',
    ].join('\n'),
    async run(args) {
      if (!controller) {
        const msg = 'Prompt refinement is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const arg = args.trim().toLowerCase();

      if (!arg) {
        const status = controller.enabled
          ? `${color.cyan('ON')} ${color.dim('(prompts are refined before sending)')}`
          : `${color.green('OFF')} ${color.dim('(prompts are sent verbatim)')}`;
        const msg = `Prompt refinement: ${status}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      let newState: boolean;
      if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') {
        newState = true;
      } else if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') {
        newState = false;
      } else if (arg === 'toggle') {
        newState = !controller.enabled;
      } else {
        const msg = `Unknown argument: ${arg}. Use /enhance on, /enhance off, or /enhance toggle.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // Flip the live toggle (TUI reducer flag + controller mirror).
      controller.setEnabled(newState);

      // Persist to config.autonomy.enhance so it survives restarts.
      if (opts.configStore && opts.paths) {
        try {
          await persistAutonomySetting(
            {
              configStore: opts.configStore,
              globalConfigPath: opts.paths.globalConfig,
              vault: noOpVault,
            },
            (autonomy) => {
              (autonomy as Record<string, unknown>).enhance = newState;
            },
          );
        } catch (err) {
          opts.renderer.writeWarning(
            `Toggle applied for this session but could not be saved: ${(err as Error).message}`,
          );
        }
      }

      const label = newState
        ? `${color.cyan('ENABLED')} — free-text prompts will be refined before sending`
        : `${color.green('DISABLED')} — prompts are sent verbatim`;
      const msg = `Prompt refinement: ${label}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
