import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContentBlock, Context, ImageBlock, Tool, ToolRegistry } from '@wrongstack/core';

export interface VisionAdapterInput {
  image: ImageBlock;
  prompt?: string;
  ctx: Context;
  signal: AbortSignal;
}

export interface VisionAdapter {
  name: string;
  describe(input: VisionAdapterInput): Promise<string>;
}

export type VisionAdapters =
  | readonly VisionAdapter[]
  | (() => readonly VisionAdapter[] | Promise<readonly VisionAdapter[]>);

export interface VisionRoutingOptions {
  supportsVision: boolean;
  adapters?: VisionAdapters;
  ctx: Context;
  signal: AbortSignal;
  prompt?: string;
  providerId?: string;
  model?: string;
}

export interface VisionRoutingResult {
  blocks: ContentBlock[];
  route: 'native' | 'adapter' | 'none';
  convertedImages: number;
  adapterName?: string;
}

export class ImageInputUnsupportedError extends Error {
  constructor(opts: { providerId?: string; model?: string; imageCount: number }) {
    const target = [opts.providerId, opts.model].filter(Boolean).join('/') || 'current model';
    super(
      `${target} does not support image input, and no image-understanding adapter is available for ${opts.imageCount} image${opts.imageCount === 1 ? '' : 's'}. Switch to a vision model or enable an MCP/tool adapter that can describe images.`,
    );
    this.name = 'ImageInputUnsupportedError';
  }
}

export async function routeImagesForModel(
  blocks: ContentBlock[],
  opts: VisionRoutingOptions,
): Promise<VisionRoutingResult> {
  const images = blocks.filter((b): b is ImageBlock => b.type === 'image');
  if (images.length === 0) {
    return { blocks, route: 'none', convertedImages: 0 };
  }
  if (opts.supportsVision) {
    return { blocks, route: 'native', convertedImages: 0 };
  }

  const adapters = await resolveAdapters(opts.adapters);
  if (adapters.length === 0) {
    throw new ImageInputUnsupportedError({
      providerId: opts.providerId,
      model: opts.model,
      imageCount: images.length,
    });
  }

  const out: ContentBlock[] = [];
  let convertedImages = 0;
  let lastErr: unknown;
  let adapterName: string | undefined;
  for (const block of blocks) {
    if (block.type !== 'image') {
      out.push(block);
      continue;
    }
    let description: string | undefined;
    for (const adapter of adapters) {
      try {
        description = await adapter.describe({
          image: block,
          prompt: opts.prompt,
          ctx: opts.ctx,
          signal: opts.signal,
        });
        adapterName = adapter.name;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!description?.trim()) {
      throw new Error(
        `No image-understanding adapter could process an image.${lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ''}`,
      );
    }
    convertedImages++;
    out.push({
      type: 'text',
      text: `[Image ${convertedImages} analyzed via ${adapterName ?? 'vision adapter'}]\n${description.trim()}`,
    });
  }

  return { blocks: out, route: 'adapter', convertedImages, adapterName };
}

async function resolveAdapters(adapters: VisionAdapters | undefined): Promise<readonly VisionAdapter[]> {
  if (!adapters) return [];
  return typeof adapters === 'function' ? await adapters() : adapters;
}

export interface ToolVisionAdapterOptions {
  prompt?: string;
}

export function createToolVisionAdapters(
  registry: ToolRegistry,
  opts: ToolVisionAdapterOptions = {},
): VisionAdapter[] {
  return registry
    .list()
    .filter(isLikelyVisionTool)
    .map((tool) => ({
      name: tool.name,
      async describe(input: VisionAdapterInput): Promise<string> {
        const currentTool = registry.get(tool.name);
        if (!currentTool) {
          throw new Error(`Tool "${tool.name}" is no longer registered`);
        }
        const built = await buildToolPayload(currentTool, input.image, input.prompt ?? opts.prompt);
        if (!built) {
          throw new Error(`Tool "${currentTool.name}" does not expose a supported image input schema`);
        }
        try {
          const result = await currentTool.execute(built.payload, input.ctx, {
            signal: input.signal,
          });
          return stringifyToolResult(result);
        } finally {
          await built.cleanup?.();
        }
      },
    }));
}

function isLikelyVisionTool(tool: Tool): boolean {
  if (tool.permission !== 'auto' || tool.mutating) return false;
  const haystack = `${tool.name} ${tool.description ?? ''} ${tool.usageHint ?? ''}`.toLowerCase();
  if (/(generate|create|draw|paint|edit|upscale|remove|write|delete)/.test(haystack)) return false;
  if (!/(vision|image|screenshot|ocr|describe|analy[sz]e)/.test(haystack)) return false;
  const props = schemaProperties(tool);
  return [
    'image',
    'base64',
    'data',
    'url',
    'image_url',
    'imageUrl',
    'path',
    'image_path',
    'imagePath',
    'image_url',
    'imageUrl',
    'file_path',
    'filePath',
    'filename',
    'file',
    'mediaType',
    'mimeType',
  ].some((key) => key in props);
}

async function buildToolPayload(
  tool: Tool,
  image: ImageBlock,
  prompt = 'Describe this image for a coding agent. Include visible text, UI state, errors, layout, and any details needed to answer the user.',
): Promise<{ payload: Record<string, unknown>; cleanup?: () => Promise<void> } | null> {
  const props = schemaProperties(tool);
  const payload: Record<string, unknown> = {};
  const mediaType = image.source.media_type ?? 'image/png';
  const data = image.source.data;
  const url = image.source.url;
  let cleanup: (() => Promise<void>) | undefined;

  const pathKey = firstPresent(props, [
    'path',
    'image_path',
    'imagePath',
    'image_url',
    'imageUrl',
    'file_path',
    'filePath',
    'filename',
    'file',
  ]);
  if (pathKey && image.source.type === 'base64' && data) {
    const p = await writeTempImage(data, mediaType);
    payload[pathKey] = p;
    cleanup = async () => {
      await fs.unlink(p).catch(() => undefined);
      await fs.rmdir(path.dirname(p)).catch(() => undefined);
    };
  } else if ('image' in props) {
    payload.image =
      image.source.type === 'base64'
        ? { type: 'base64', mediaType, media_type: mediaType, data }
        : { type: 'url', url };
  } else if (image.source.type === 'base64' && 'base64' in props) {
    payload.base64 = data;
  } else if (image.source.type === 'base64' && 'data' in props) {
    payload.data = data;
  } else if (image.source.type === 'url' && 'url' in props) {
    payload.url = url;
  } else if (image.source.type === 'url' && 'image_url' in props) {
    payload.image_url = url;
  } else if (image.source.type === 'url' && 'imageUrl' in props) {
    payload.imageUrl = url;
  } else {
    return null;
  }

  if ('mediaType' in props) payload.mediaType = mediaType;
  if ('mimeType' in props) payload.mimeType = mediaType;
  if ('media_type' in props) payload.media_type = mediaType;
  if ('prompt' in props) payload.prompt = prompt;
  if ('query' in props) payload.query = prompt;
  if ('instruction' in props) payload.instruction = prompt;
  return { payload, cleanup };
}

function firstPresent(props: Record<string, unknown>, keys: string[]): string | undefined {
  return keys.find((key) => key in props);
}

async function writeTempImage(data: string, mediaType: string): Promise<string> {
  const ext = mediaType.includes('jpeg') || mediaType.includes('jpg') ? 'jpg' : 'png';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-vision-'));
  const file = path.join(dir, `image.${ext}`);
  await fs.writeFile(file, data, 'base64');
  return file;
}

function schemaProperties(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return {};
  const props = (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .join('\n');
  }
  if (value && typeof value === 'object' && 'text' in value) {
    return String((value as { text?: unknown }).text ?? '');
  }
  return JSON.stringify(value);
}
