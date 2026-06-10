const fs = require('fs');
const path = require('path');

// Check @tailwindcss/vite in pnpm store
const vitePnpmPath = 'node_modules/.pnpm/@tailwindcss+vite@4.3.0_vit_83bee9ccb4b6e66ef843012b940ce8dd/node_modules/@tailwindcss/vite';
try {
  const p = JSON.parse(fs.readFileSync(path.join(vitePnpmPath, 'package.json'), 'utf8'));
  console.log('@tailwindcss/vite (store):');
  console.log('  version:', p.version);
  console.log('  deps:', JSON.stringify(p.dependencies));
  console.log('  peerDeps:', JSON.stringify(p.peerDependencies));
} catch(e) {
  console.log('@tailwindcss/vite NOT FOUND in store:', e.message);
}

// Also check the webui's lockfile entry for vite
// Look for vite@6 in pnpm-lock.yaml
try {
  const lock = fs.readFileSync('pnpm-lock.yaml', 'utf8');
  const lines = lock.split('\n');
  const viteLines = lines.filter(l => l.includes('vite@6') || l.includes('vite@'));
  console.log('\nVite entries in pnpm-lock.yaml:');
  viteLines.slice(0, 10).forEach(l => console.log(' ', l.trim()));
} catch(e) {
  console.log('Could not read pnpm-lock.yaml:', e.message);
}
