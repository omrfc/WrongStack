const fs = require('fs');
const c = fs.readFileSync('packages/tui/src/app.tsx', 'utf8');
const lines = c.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('StatusBar')) {
    console.log((i + 1) + ': ' + lines[i].trim());
  }
}
