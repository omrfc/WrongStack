import type { Request } from '@wrongstack/core';
import type { Capabilities } from '@wrongstack/core';
import { capabilitiesForFamily } from './family-capabilities.js';
import { OpenAIProvider } from './openai.js';

export interface CompatibilityQuirks {
  stripCacheControl?: boolean;
  systemAsMessage?: boolean;
  flattenContentToString?: boolean;
  preserveToolCallIds?: boolean;
  parallelToolsDisabled?: boolean;
  jsonArgumentsBuggy?: boolean;
  emptyToolCallContent?: 'null' | 'empty_string';
}

export interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
  quirks?: CompatibilityQuirks;
  capabilities?: Partial<Capabilities>;
  fetchImpl?: typeof fetch;
  /**
   * Optional override for URL construction. Receives the base URL and request,
   * returns the full URL to use. Allows custom providers with non-standard
   * URL structures (e.g. Google with model-in-path, Anthropic with /v1/messages).
   */
  urlOverride?: (baseUrl: string, req: Request) => string;
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  private readonly extraHeaders?: Record<string, string>;
  private readonly urlOverride?: (baseUrl: string, req: Request) => string;

  constructor(opts: OpenAICompatibleOptions) {
    super({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      id: opts.id,
      capabilities: capabilitiesForFamily('openai-compatible', {
        parallelTools: !opts.quirks?.parallelToolsDisabled,
        systemPrompt: !opts.quirks?.systemAsMessage,
        ...opts.capabilities,
      }),
      quirks: opts.quirks,
    });
    this.extraHeaders = opts.headers;
    this.urlOverride = opts.urlOverride;
  }

  protected override buildUrl(req: Request): string {
    if (this.urlOverride) {
      return this.urlOverride(this.baseUrl, req);
    }
    return super.buildUrl(req);
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      ...this.extraHeaders,
    };
  }
}
