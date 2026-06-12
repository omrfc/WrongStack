import('@wrongstack/core').then(m => {
  console.log('truncate:', typeof m.truncate);
}).catch(e => console.log('Error:', e.message));
