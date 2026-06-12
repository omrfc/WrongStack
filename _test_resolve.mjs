import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(path.join(__dirname, '_test_resolve.mjs'));

try {
  const r = require2.resolve('@wrongstack/core');
  console.log('Resolved to:', r);
} catch (e) {
  console.log('Failed to resolve:', e.message);
}
