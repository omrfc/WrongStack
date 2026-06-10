import * as fs from 'node:fs';
const src = fs.readFileSync('packages/webui/src/server/provider-handlers.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('ProviderHandlerDeps') || lines[i].includes('createProviderHandlers') || lines[i].includes('logger')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
