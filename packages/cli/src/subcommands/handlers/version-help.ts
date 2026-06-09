import * as os from 'node:os';
import { color } from '@wrongstack/core';
import { API_VERSION, CLI_VERSION } from '../../version.js';
import type { SubcommandHandler } from '../index.js';

export const versionCmd: SubcommandHandler = async (_args, deps) => {
  deps.renderer.write(
    `WrongStack ${CLI_VERSION} (apiVersion ${API_VERSION}, node ${process.version}, ${os.platform()})\n`,
  );
  return 0;
};

export const helpCmd: SubcommandHandler = async (_args, deps) => {
  const lines = [
    color.bold('WrongStack — usage'),
    '',
    '  wstack                       Start REPL',
    '  wstack "<task>"              Run task and exit',
    '  wstack --eternal "<mission>" Launch eternal-autonomy loop against a goal — Ctrl+C to stop',
    '  wstack resume [<id>]         Resume a session',
    '  wstack sessions              List recent sessions',
    '  wstack init                  Pick provider + model from models.dev',
    '  wstack auth                  Interactive key manager (list/add/update/delete)',
    '  wstack auth list             Quick listing of saved providers and keys',
    '  wstack auth status <id>      Detailed view of one provider',
    '  wstack auth remove <id>      Delete a provider (asks for confirmation)',
    '  wstack auth <provider>       Add a key for a provider (--label, --family, …)',
    '  wstack config [show|edit]    Show or edit effective config',
    '  wstack tools                 List registered tools',
    '  wstack skills                List discovered skills',
    '  wstack providers [--all]     List providers from models.dev',
    '  wstack models [<provider>]   List models',
    '  wstack models refresh        Force-refresh cache',
    '  wstack models add <mid>      Add/override custom model (--max-context, --tools, --vision, …)',
    '  wstack models remove <mid>   Remove a custom model',
    '  wstack models list           List all custom models',
    '  wstack mcp [list]            List MCP servers',
    '  wstack plugin [list|status|official|install|add|remove|enable|disable]  Manage plugins',
    '  wstack projects              List tracked projects',
    '  wstack diag                  Full diagnostics',
    '  wstack doctor                Health checks',
    '  wstack export <id> [opts]    Render a session',
    '  wstack usage                 Token + cost summary',
    '  wstack version               Print version',
    '',
    color.bold('Common flags'),
    '  --yolo                       Auto-approve all tool calls (including destructive)',
    '  --confirm-destructive         In YOLO mode, still prompt for destructive operations',
    '  --yolo-destructive            Deprecated — YOLO now auto-approves everything by default',
    '  --tui / --no-tui             Force or disable TUI mode',
    '  --webui [--port <n>] [--open] Serve the browser UI + WS bridge (prints a URL,',
    '                               --open pops the browser; shares this terminal\'s',
    '                               agent; auto-picks free ports)',
    '  --eternal "<mission>"        Start an eternal-autonomy loop',
    '  --no-hints                   Hide launch hints',
    '  --skip-index                 Skip codebase indexing and the large-codebase prompt',
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
};
