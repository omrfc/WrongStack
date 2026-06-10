const fs = require('fs');
const path = 'node_modules/.pnpm';
const dirs = fs.readdirSync(path).filter(d => d.startsWith('vite@'));
console.log(dirs.join('\n'));
