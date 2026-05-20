import { color } from '@wrongstack/core';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';
import { redactKeys } from './helpers.js';
import { sessionsFleetCmd } from './sessions-fleet.js';
import {
  listHistory,
  getHistoryEntry,
  restoreFromHistory,
  restoreLast,
} from '../../config-history.js';

export const sessionsCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  // `wrongstack sessions fleet [runId]` — fleet run inspection
  if (sub === 'fleet') {
    return sessionsFleetCmd(args.slice(1), deps);
  }
  if (!deps.sessionStore) {
    deps.renderer.writeError('No session store available.');
    return 1;
  }
  const list = await deps.sessionStore.list(20);
  if (list.length === 0) {
    deps.renderer.write('No sessions found.\n');
    return 0;
  }
  for (const s of list)
    deps.renderer.write(
      `  ${s.id}  ${color.dim(s.startedAt)}  ${color.dim(`${s.tokenTotal} tok`)}  ${s.title}\n`,
    );
  return 0;
};

export const configCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  if (!sub || sub === 'show') {
    deps.renderer.write(JSON.stringify(redactKeys(deps.config), null, 2) + '\n');
    return 0;
  }
  if (sub === 'edit') {
    const editor = process.env['EDITOR'] ?? 'vi';
    deps.renderer.write(`Run: ${editor} ${deps.paths.globalConfig}\n`);
    return 0;
  }
  if (sub === 'history') {
    return runHistory(args.slice(1), deps);
  }
  if (sub === 'restore') {
    return runRestore(args.slice(1), deps);
  }
  deps.renderer.writeError(`Unknown config subcommand: ${sub}\n`);
  return 1;
};

function extractArg(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx !== -1 && args[idx + 1] !== undefined) return args[idx + 1]!;
  const eq = key.startsWith('--') ? args.find((a) => a.startsWith(`${key}=`)) : null;
  if (eq) return eq.slice(eq.indexOf('=') + 1);
  return null;
}

async function runHistory(args: string[], deps: SubcommandDeps): Promise<number> {
  const idFlag = extractArg(args, '--id');
  if (idFlag) {
    const entry = await getHistoryEntry(idFlag);
    if (!entry) {
      deps.renderer.writeError(`History entry '${idFlag}' not found.\n`);
      return 1;
    }
    deps.renderer.write(
      [
        `ID:      ${entry.id}`,
        `Time:    ${new Date(entry.timestamp).toLocaleString()}`,
        `Change:  ${entry.description}`,
        `Diff:    ${entry.diffSummary}`,
        '',
        'Snapshot (secrets masked):',
        JSON.stringify(entry.snapshotMasked, null, 2),
      ].join('\n') + '\n',
    );
    return 0;
  }

  const entries = await listHistory();
  if (entries.length === 0) {
    deps.renderer.write('No config history yet.\n');
    return 0;
  }

  deps.renderer.write(
    [
      color.bold('Config History'),
      '',
      ...entries.map((e, i) => {
        const ts = new Date(e.timestamp).toLocaleString();
        const desc = e.description.length > 60 ? e.description.slice(0, 60) + '…' : e.description;
        return `  [${i + 1}] ${e.id}  ${color.dim(ts)}\n     ${desc}`;
      }),
      '',
      '  Run `wrongstack config history --id <id>` for details.',
      '  Run `wrongstack config restore <id>` to restore.',
    ].join('\n') + '\n',
  );
  return 0;
}

async function runRestore(args: string[], deps: SubcommandDeps): Promise<number> {
  const latest = args.includes('--latest') || args.includes('-l');
  const id = extractArg(args, '--id') ?? (args[0] && !args[0]!.startsWith('-') ? args[0] : null);

  if (latest) {
    const result = await restoreLast();
    if (!result.ok) {
      deps.renderer.writeError(`Restore failed: ${result.error}\n`);
      return 1;
    }
    deps.renderer.write('Restored from config.json.last.\n');
    return 0;
  }

  if (!id) {
    deps.renderer.write('Usage: wrongstack config restore <id> | --latest\n');
    return 1;
  }

  const result = await restoreFromHistory(id);
  if (!result.ok) {
    deps.renderer.writeError(`Restore failed: ${result.error}\n`);
    return 1;
  }

  deps.renderer.write(`Restored to history entry '${id}'. Backup created.\n`);
  return 0;
}
