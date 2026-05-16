import { ToolRegistry, type Context, type Tool } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import {
  ImageInputUnsupportedError,
  createToolVisionAdapters,
  routeImagesForModel,
} from '../src/vision.js';

const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' },
};

const ctx = {} as Context;

describe('vision routing', () => {
  it('keeps image blocks intact when the model supports native vision', async () => {
    const result = await routeImagesForModel([{ type: 'text', text: 'look' }, image], {
      supportsVision: true,
      ctx,
      signal: new AbortController().signal,
    });

    expect(result.route).toBe('native');
    expect(result.blocks[1]).toBe(image);
  });

  it('throws a clear error when images have no native or adapter route', async () => {
    await expect(
      routeImagesForModel([image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
        providerId: 'zai',
        model: 'text-only',
      }),
    ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
  });

  it('converts images through a vision adapter for text-only models', async () => {
    const result = await routeImagesForModel([{ type: 'text', text: 'what?' }, image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: [
        {
          name: 'test-vision',
          async describe() {
            return 'A screenshot with an error dialog.';
          },
        },
      ],
    });

    expect(result.route).toBe('adapter');
    expect(result.blocks).toEqual([
      { type: 'text', text: 'what?' },
      {
        type: 'text',
        text: '[Image 1 analyzed via test-vision]\nA screenshot with an error dialog.',
      },
    ]);
  });

  it('resolves adapter providers at routing time', async () => {
    let calls = 0;
    const result = await routeImagesForModel([image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: () => {
        calls++;
        return [
          {
            name: 'late-vision',
            async describe() {
              return 'late MCP tool saw the image';
            },
          },
        ];
      },
    });

    expect(calls).toBe(1);
    expect(result.adapterName).toBe('late-vision');
    expect(result.blocks).toEqual([
      {
        type: 'text',
        text: '[Image 1 analyzed via late-vision]\nlate MCP tool saw the image',
      },
    ]);
  });

  it('discovers safe auto image-understanding tools as adapters', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_image',
      description: 'Analyze an image and return a textual description.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'object' },
          prompt: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(input).toMatchObject({
          image: { type: 'base64', data: 'AAAA' },
        });
        return 'visible UI';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    expect(adapters.map((a) => a.name)).toEqual(['mcp__vision__describe_image']);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('visible UI');
  });

  it('re-resolves adapter tools from the registry before execution', async () => {
    const registry = new ToolRegistry();
    const original: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_image',
      description: 'Analyze an image and return a textual description.',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'stale tool';
      },
    };
    const fresh: Tool<Record<string, unknown>, string> = {
      ...original,
      async execute() {
        return 'fresh tool';
      },
    };
    registry.register(original);
    const adapters = createToolVisionAdapters(registry);
    registry.unregister(original.name);
    registry.register(fresh);

    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('fresh tool');
  });

  it('supports path-based MCP vision tools by writing a temporary image file', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__zai_mcp_server__image_analysis',
      description: 'General-purpose image understanding.',
      inputSchema: {
        type: 'object',
        properties: {
          image_path: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(typeof input.image_path).toBe('string');
        expect(String(input.image_path)).toMatch(/wstack-vision-/);
        return 'zai saw a screenshot';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('zai saw a screenshot');
  });

  it('supports MiniMax-style understand_image tools that accept image_url paths', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__MiniMax__understand_image',
      description: 'Analyze and understand image content with AI vision capabilities.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          image_url: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(typeof input.image_url).toBe('string');
        expect(String(input.image_url)).toMatch(/wstack-vision-/);
        expect(input.prompt).toContain('Describe this image');
        return 'minimax saw the UI';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    expect(adapters.map((a) => a.name)).toEqual(['mcp__MiniMax__understand_image']);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('minimax saw the UI');
  });
});
