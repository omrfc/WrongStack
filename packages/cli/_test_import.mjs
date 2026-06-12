import('@wrongstack/core').then(m => {
  console.log('truncate:', typeof m.truncate);
  console.log('module URL:', import.meta.url);
}).catch(e => console.log('Error:', e.message, e.code));
