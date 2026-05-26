const fs = require('fs');
let content = fs.readFileSync('packages/tui/src/app.tsx', 'utf8');
const oldBlock = `  // \`/agents monitor\` — opens the agents monitor overlay (Ctrl+Shift+M).
  useEffect(() => {
    const cmd = {
      name: 'agents',
      description: 'Toggle the agents monitor overlay.',
      async run() {
        dispatch({ type: 'toggleAgentsMonitor' });
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => { slashRegistry.unregister('agents'); };
  }, [slashRegistry]);`;
const newBlock = `  // \`/agents\` — bare \`/agents\` and \`/agents monitor\` toggle the overlay.
  // \`/agents <id>\` falls through to the CLI builtin (same-name registration
  // from the same 'core' owner is a no-op per SlashCommandRegistry semantics,
  // so we own the bare/monitor forms here and let the builtin handle IDs).
  useEffect(() => {
    const cmd = {
      name: 'agents',
      description: 'Toggle the agents monitor overlay.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (!arg || arg === 'monitor') {
          dispatch({ type: 'toggleAgentsMonitor' });
          return { message: undefined };
        }
        // Any other arg falls through to the CLI builtin (same owner
        // 'core' re-registration = silently ignored). The builtin handles
        // onAgents UUID lookups and /agents on|off.
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => { slashRegistry.unregister('agents'); };
  }, [slashRegistry]);`;
if (!content.includes(oldBlock)) { console.log('OLD BLOCK NOT FOUND'); process.exit(1); }
content = content.replace(oldBlock, newBlock);
fs.writeFileSync('packages/tui/src/app.tsx', content);
console.log('OK');