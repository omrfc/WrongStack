// Mimic what vitest fork worker does when importing @wrongstack/core
const { fork } = await import('child_process');
const path = await import('path');
const { fileURLToPath } = await import('url');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const child = fork(path.join(__dirname, '_child.mjs'), {
  cwd: __dirname,
  execArgv: [],
});

child.on('message', msg => console.log('Parent got:', msg));
child.on('exit', code => console.log('Child exited:', code));
