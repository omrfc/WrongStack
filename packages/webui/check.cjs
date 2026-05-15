const fs = require('node:fs');
const path = 'D:/Codebox/PROJECTS/WrongStack/packages/webui/src/components/ThemeProvider.tsx';
try {
  const stat = fs.statSync(path);
  console.log('File exists:', stat.isFile(), 'Size:', stat.size);
} catch (e) {
  console.log('File does not exist:', e.message);
}
