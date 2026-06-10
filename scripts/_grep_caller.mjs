import * as fs from 'node:fs';
const targets = ['packages/cli/src/execution.ts', 'packages/cli/src/slash-commands/enhance.ts', 'packages/cli/src/slash-commands/settings.ts'];
for (const f of targets) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/persistAutonomy|persistExtension|persistTelegram/.test(lines[i])) {
      // Find the call
      const start = i;
      let depth = 0;
      let end = i;
      for (let j = i; j < Math.min(i + 30, lines.length); j++) {
        for (const ch of lines[j]) {
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        if (end > start) break;
      }
      console.log(`\n--- ${f}:${start + 1}-${end + 1} ---`);
      for (let j = start; j <= end; j++) {
        console.log(`  ${j + 1}: ${lines[j].trim()}`);
      }
    }
  }
}
