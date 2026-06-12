// Test ESM resolution of @wrongstack/core
const path = require('path');
const { createRequire } = require('module');
const require2 = createRequire(__filename);
try {
  const r = require2.resolve('@wrongstack/core');
  console.log('Resolved to:', r);
} catch (e) {
  console.log('Failed to resolve:', e.message);
}
