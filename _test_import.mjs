import('@wrongstack/core').then(m => {
  console.log('truncate:', typeof m.truncate);
  console.log('keys:', Object.keys(m).slice(0, 10));
}).catch(e => console.log('Error:', e.message));
