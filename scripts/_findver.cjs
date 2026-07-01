const fs = require('node:fs');
const read = (f) => fs.readFileSync(f, 'utf8').split('\n');
console.log('--- README stale 0.27x references ---');
read('README.md').forEach((l, i) => {
  if (/0\.27[0-4]\.0/.test(l)) console.log(`${i + 1}: ${l}`);
});
console.log('--- CHANGELOG top header ---');
read('CHANGELOG.md').slice(0, 12).forEach((l, i) => {
  console.log(`${i + 1}: ${l}`);
});
