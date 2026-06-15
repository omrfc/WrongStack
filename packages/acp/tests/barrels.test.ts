import { describe, expect, it } from 'vitest';

// Smoke-test the public barrel entry points so they are loaded and their
// re-exports stay wired.
describe('acp barrels', () => {
  it('root index re-exports the public surface', async () => {
    const mod = await import('../src/index.js');
    expect(mod.StdioTransport).toBeDefined();
    expect(mod.ClientTransport).toBeDefined();
    expect(mod.ACPToolsRegistry).toBeDefined();
    expect(mod.ACPProtocolHandler).toBeDefined();
    expect(mod.WrongStackACPServer).toBeDefined();
    expect(mod.ToolTranslator).toBeDefined();
    expect(mod.makeACPSubagentRunner).toBeDefined();
    expect(mod.makeACPSubagentRunnerWithStop).toBeDefined();
    expect(mod.ACP_AGENT_COMMANDS).toBeDefined();
  });

  it('agent barrel re-exports server-side classes', async () => {
    const mod = await import('../src/agent/index.js');
    expect(mod.StdioTransport).toBeDefined();
    expect(mod.ACPToolsRegistry).toBeDefined();
    expect(mod.ACPProtocolHandler).toBeDefined();
    expect(mod.WrongStackACPServer).toBeDefined();
  });

  it('client barrel re-exports client-side classes', async () => {
    const mod = await import('../src/client/index.js');
    expect(mod.ClientTransport).toBeDefined();
    expect(mod.ToolTranslator).toBeDefined();
    expect(mod.makeACPSubagentRunner).toBeDefined();
  });
});
