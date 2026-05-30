import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import webSearchPlugin from '../src/web-search';

const mockApi = {
  tools: {
    register: vi.fn()
  },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
};

describe('web-search plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      webSearchPlugin.teardown?.(mockApi as any);
    } catch {
      // ignore
    }
  });

  it('exports a default Plugin object', () => {
    expect(webSearchPlugin).toBeDefined();
    expect(typeof webSearchPlugin).toBe('object');
  });

  it('plugin has correct name', () => {
    expect(webSearchPlugin.name).toBe('web-search');
  });

  it('plugin has correct apiVersion', () => {
    expect(webSearchPlugin.apiVersion).toMatch(/^\^?0\.1/);
  });

  it('registers web_search tool', () => {
    webSearchPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('web_search');
  });

  it('registers web_fetch tool', () => {
    webSearchPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('web_fetch');
  });

  it('web_search tool has correct schema', () => {
    webSearchPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'web_search'
    )?.[0];

    expect(tool).toBeDefined();
    expect(tool?.name).toBe('web_search');
    expect(tool?.permission).toBe('auto');
    // web_search makes outbound network calls — declared mutating so the
    // permission policy gates it instead of silently auto-approving.
    expect(tool?.mutating).toBe(true);
    const schema = tool?.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain('query');
    expect(schema.properties['query']).toBeDefined();
  });

  describe('web_fetch SSRF guard', () => {
    it('blocks localhost', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://localhost/secret' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked localhost');
    });

    it('blocks 127.0.0.1', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://127.0.0.1/secret' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked private/loopback');
    });

    it('blocks 10.x.x.x', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://10.0.0.1/secret' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked private/loopback');
    });

    it('blocks 169.254.x.x (IMDS)', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked private/loopback');
    });

    it('blocks 192.168.x.x', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://192.168.1.1/secret' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked private/loopback');
    });

    it('blocks non-http protocols', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      // The execute() method checks startsWith('http') before assertSafeUrl,
      // so file:// is caught by the URL prefix check, not the protocol check.
      const result = await tool.execute({ url: 'file:///etc/passwd' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/http|protocol/i);
    });

    it('blocks 0.0.0.0', async () => {
      webSearchPlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'web_fetch'
      )?.[0];
      const result = await tool.execute({ url: 'http://0.0.0.0/secret' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Blocked localhost');
    });
  });
});