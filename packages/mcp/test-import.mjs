import('@wrongstack/mcp')
  .then((m) => {
    console.log('OK - MCPClient:', typeof m.MCPClient);
    console.log('OK - MCPRegistry:', typeof m.MCPRegistry);
  })
  .catch((e) => {
    console.error('ERROR:', e.message);
  });
