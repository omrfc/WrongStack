const fs = require('fs');
const c = fs.readFileSync('D:/Codebox/PROJECTS/WrongStack/packages/tui/src/app.tsx', 'utf8');
const lines = c.split('\n');
console.log('Total lines:', lines.length);
lines.forEach((l, i) => {
  if (l.includes('autonomyPickerOpen') || l.includes('case \'autonomyPicker')) {
    console.log((i+1) + ': ' + l.trim());
  }
});