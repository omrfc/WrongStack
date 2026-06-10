const fs = require('fs');
const path = require('path');

const distPath = 'packages/webui/dist';
try {
  const entries = fs.readdirSync(distPath);
  console.log('dist contents:');
  entries.forEach(e => console.log(' ', e));
  
  // Check for server
  const serverPath = path.join(distPath, 'server');
  try {
    const serverEntries = fs.readdirSync(serverPath);
    console.log('\nserver contents:');
    serverEntries.forEach(e => console.log(' ', e));
  } catch(e) {
    console.log('\nNo server dir:', e.code);
  }
} catch(e) {
  console.log('dist not found:', e.code);
}
