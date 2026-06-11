import * as fs from 'node:fs';
const tools = await import('./packages/tools/dist/index.js');
const { bashTool } = tools;
const ac = new AbortController();
const ctx = { cwd: process.cwd(), projectRoot: process.cwd(), state: { appendMessage() {}, messages: [] }, meta: {} };
let n = 0, bytes = 0;
const samples = [];
const t0 = Date.now();
for await (const ev of bashTool.executeStream({ command: 'pnpm test 2>&1', timeout_ms: 300000 }, ctx, { signal: ac.signal })) {
  if (ev.type === 'final') break;
  if (ev.type !== 'partial_output' || !ev.text) continue;
  n++; bytes += ev.text.length;
  if (samples.length < 3 || n % 500 === 0) samples.push(`--- ev#${n} (${ev.text.length}b) ---\n${ev.text.slice(0, 600)}`);
}
console.log(`events=${n} totalMB=${(bytes/1048576).toFixed(1)} in ${Math.round((Date.now()-t0)/1000)}s`);
fs.writeFileSync('leak-samples.txt', samples.join('\n\n'));
