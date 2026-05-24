const fs = require('fs');
const c = fs.readFileSync('D:/Codebox/PROJECTS/WrongStack/packages/tui/src/app.tsx', 'utf8');
const lines = c.split('\n');
console.log('Lines:', lines.length);
// Find autonomyPickerOpen occurrences
lines.forEach((l, i) => {
  if (l.includes('autonomyPickerOpen')) {
    console.log((i+1) + ': ' + l.trim());
  }
  if (l.includes('case \'autonomyPicker')) {
    console.log((i+1) + ': ' + l.trim());
  }
});