import * as fs from 'node:fs/promises';
import {
  type ConfigStore,
  type SecretVault,
  color,
  decryptConfigSecrets,
  encryptConfigSecrets,
  atomicWrite,
} from '@wrongstack/core';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';

export interface SettingsMenuDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  configStore: ConfigStore;
  globalConfigPath: string;
  vault: SecretVault;
}

/**
 * Interactive settings manager. Shows current configuration values,
 * lets the user edit them, and persists changes back to the config file.
 * Loops until the user exits.
 */
export async function runSettingsMenu(deps: SettingsMenuDeps): Promise<number> {
  for (;;) {
    const config = deps.configStore.get();
    renderSettingsTopMenu(deps.renderer, config);

    const choice = (await deps.reader.readLine(`\n${color.amber('?')} Pick setting to edit: `))
      .trim()
      .toLowerCase();

    if (!choice || choice === 'q' || choice === 'quit' || choice === 'exit') {
      deps.renderer.write(color.dim('Done.\n'));
      return 0;
    }

    switch (choice) {
      case '1':
        await editAutoProceedDelay(deps);
        break;
      case '2':
        await editDefaultAutonomy(deps);
        break;
      case 'd':
        await showDefaults(deps);
        break;
      default:
        deps.renderer.writeError(`Unknown selection: "${choice}". Try 1, 2, or q to quit.`);
    }
  }
}

function renderSettingsTopMenu(renderer: TerminalRenderer, config: { autonomy?: { autoProceedDelayMs?: number; defaultMode?: string } }): void {
  const delay = config.autonomy?.autoProceedDelayMs ?? 45_000;
  const defMode = config.autonomy?.defaultMode ?? 'off';
  renderer.write(`\n${color.bold('WrongStack')} ${color.dim('— Settings')}\n\n`);
  renderer.write(`  ${color.bold('1.')} auto-proceed delay:    ${color.cyan(formatDelay(delay))} (in auto mode, wait before continuing)\n`);
  renderer.write(`  ${color.bold('2.')} default autonomy mode: ${color.cyan(defMode)}\n`);
  renderer.write(`\n  ${color.dim('Actions:')}\n`);
  renderer.write(`    ${color.bold('1')}       Edit auto-proceed delay\n`);
  renderer.write(`    ${color.bold('2')}       Edit default autonomy mode\n`);
  renderer.write(`    ${color.bold('d')}       Show all defaults\n`);
  renderer.write(`    ${color.bold('q')}       Quit\n`);
}

async function editAutoProceedDelay(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(`\n${color.bold('Auto-proceed delay')} ${color.dim('— wait time before auto-continuing in auto mode')}\n`);
  deps.renderer.write(color.dim(`  Current: ${formatDelay(deps.configStore.get().autonomy?.autoProceedDelayMs ?? 45_000)}\n`));
  deps.renderer.write(color.dim(`  Enter value in SECONDS (e.g. 30 for 30 seconds, 0 to disable)\n`));

  const raw = (await deps.reader.readLine(`  ${color.amber('?')} Delay (seconds): `)).trim();
  if (!raw || raw === 'q') return;

  const seconds = Number.parseFloat(raw);
  if (Number.isNaN(seconds) || seconds < 0) {
    deps.renderer.writeError(`Invalid number: "${raw}"`);
    return;
  }

  const ms = Math.round(seconds * 1000);
  await mutateAutonomyConfig(deps, (autonomy) => {
    autonomy.autoProceedDelayMs = ms;
  });
  deps.renderer.write(`  ${color.green('✓')} auto-proceed delay → ${formatDelay(ms)}\n`);
}

async function editDefaultAutonomy(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(`\n${color.bold('Default Autonomy Mode')}\n\n`);
  deps.renderer.write(`  ${color.bold('1.')} off     — agent stops after each turn (normal)\n`);
  deps.renderer.write(`  ${color.bold('2.')} suggest — shows next-step suggestions\n`);
  deps.renderer.write(`  ${color.bold('3.')} auto    — self-driving, agent continues automatically\n`);
  deps.renderer.write(`  ${color.bold('q')}  Quit without changing\n`);

  const raw = (await deps.reader.readLine(`  ${color.amber('?')} Default mode: `)).trim().toLowerCase();
  if (!raw || raw === 'q') return;

  const modes = ['off', 'suggest', 'auto'];
  let selected: string | null = null;
  if (raw === '1') selected = 'off';
  else if (raw === '2') selected = 'suggest';
  else if (raw === '3') selected = 'auto';
  else if (modes.includes(raw)) selected = raw;

  if (!selected) {
    deps.renderer.writeError(`Invalid mode: "${raw}". Use off, suggest, or auto.`);
    return;
  }

  await mutateAutonomyConfig(deps, (autonomy) => {
    autonomy.defaultMode = selected as 'off' | 'suggest' | 'auto';
  });
  deps.renderer.write(`  ${color.green('✓')} default autonomy → ${color.bold(selected)}\n`);
}

async function showDefaults(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(`\n${color.bold('Default Values')}\n\n`);
  deps.renderer.write(`  auto-proceed delay:    ${color.cyan('45s')} (WRONGSTACK_AUTO_PROCEED_DELAY_MS env)\n`);
  deps.renderer.write(`  default autonomy mode:  ${color.cyan('off')}\n`);
  deps.renderer.write(`  iteration timeout:      ${color.cyan('5 min')}\n`);
  deps.renderer.write(`  session timeout:        ${color.cyan('30 min')}\n`);
  deps.renderer.write(`  max iterations:         ${color.cyan('100')}\n`);
  deps.renderer.write(`\n${color.dim('  Press Enter to continue...')}`);
  await deps.reader.readLine('');
}

async function mutateAutonomyConfig(
  deps: SettingsMenuDeps,
  mutator: (autonomy: { autoProceedDelayMs?: number; defaultMode?: string }) => void,
): Promise<void> {
  let raw: string;
  let fileExists = true;
  try {
    raw = await fs.readFile(deps.globalConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${deps.globalConfigPath}: ${(err as Error).message}`);
    }
    fileExists = false;
    raw = '{}';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new Error(`Config at ${deps.globalConfigPath} is not valid JSON: ${(err as Error).message}`);
    }
    parsed = {};
  }

  const decrypted = decryptConfigSecrets(parsed, deps.vault) as Record<string, unknown>;
  const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
  mutator(autonomy as { autoProceedDelayMs?: number; defaultMode?: string });
  decrypted.autonomy = autonomy;

  const encrypted = encryptConfigSecrets(decrypted, deps.vault);
  await atomicWrite(deps.globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

  // Also update the in-memory config store so changes are immediately visible
  deps.configStore.update({ autonomy: decrypted.autonomy as Parameters<typeof deps.configStore.update>[0]['autonomy'] });
}

function formatDelay(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms === 0) return 'disabled';
  return `${Math.round(ms / 1000)}s`;
}