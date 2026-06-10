import * as fs from 'node:fs';
const src = fs.readFileSync('packages/webui/src/server/provider-store.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('deps') || lines[i].includes('interface') || lines[i].includes('createProviderStore') || lines[i].includes('loadSavedProviders') || lines[i].includes('function ')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
