import { useWebSocket } from '@/hooks/useWebSocket';
import { useConfigStore, useUIStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import { trackEvent } from '@/lib/analytics';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Gift,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Zap,
  Shield,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

interface SavedProvider {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

// ── Popular Provider (loaded from JSON) ───────────────────────────────────────

interface PopularProvider {
  id: string;
  name: string;
  description: string;
  icon: string; // emoji or text icon
  color: string; // tailwind classes
  keyPlaceholder: string;
  docsUrl?: string;
  family: string;
  referral?: {
    code: string;
    reward: string;
    url: string;
  };
}

const DEFAULT_POPULAR_PROVIDERS: PopularProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT, o-series, and Codex models',
    icon: '🤖',
    color: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30 hover:border-emerald-500/50',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    family: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude Opus, Sonnet, and Haiku',
    icon: '🧠',
    color: 'from-amber-500/20 to-amber-500/5 border-amber-500/30 hover:border-amber-500/50',
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    family: 'anthropic',
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini Pro, Flash, and Nano',
    icon: '✨',
    color: 'from-blue-500/20 to-blue-500/5 border-blue-500/30 hover:border-blue-500/50',
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/apikey',
    family: 'google',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'High-performance reasoning at low cost',
    icon: '🐋',
    color: 'from-sky-500/20 to-sky-500/5 border-sky-500/30 hover:border-sky-500/50',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    family: 'openai-compatible',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'All models via one key',
    icon: '🔀',
    color: 'from-violet-500/20 to-violet-500/5 border-violet-500/30 hover:border-violet-500/50',
    keyPlaceholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    family: 'openai-compatible',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'Subscribe to one plan and unlock the latest models, including frontier coding capabilities, 1M ultra-long context, and native multimodality. Text, image, and speech models all share the same quota. Invite Friends, Win Together: Friends get 10% off plus Builder benefits when they subscribe, while referrers earn 10% cashback plus community perks.',
    icon: '🔮',
    color: 'from-fuchsia-500/20 to-fuchsia-500/5 border-fuchsia-500/30 hover:border-fuchsia-500/50',
    keyPlaceholder: 'eyJ...',
    docsUrl: 'https://platform.minimax.io/subscribe/token-plan?code=JrA4R9QAEn&source=link',
    family: 'openai-compatible',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    description: 'Moonshot AI long-context models',
    icon: '🌙',
    color: 'from-cyan-500/20 to-cyan-500/5 border-cyan-500/30 hover:border-cyan-500/50',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://www.kimi.com/membership/pricing',
    family: 'openai-compatible',
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    description: "You've been invited to join the GLM Coding Plan! Enjoy full support for Claude Code, Cline, and 20+ top coding tools — starting at just $18/month. Subscribe now and grab the limited-time deal!",
    icon: '🔷',
    color: 'from-indigo-500/20 to-indigo-500/5 border-indigo-500/30 hover:border-indigo-500/50',
    keyPlaceholder: '...',
    docsUrl: 'https://z.ai/subscribe?ic=JQZ7TPPRA6',
    family: 'openai-compatible',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    description: 'Global hosted API for 75+ LLM providers — stable access from US, EU, and Singapore',
    icon: '🌍',
    color: 'from-teal-500/20 to-teal-500/5 border-teal-500/30 hover:border-teal-500/50',
    keyPlaceholder: 'oc-...',
    docsUrl: 'https://opencode.ai/go?ref=6VZAER87H4',
    family: 'openai-compatible',
  },
];

/** Load popular providers from a remote JSON source (e.g. GitHub raw).
 *  Falls back to the built-in defaults if the fetch fails. */
async function loadPopularProviders(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<PopularProvider[]> {
  try {
    const res = await fetch(sourceUrl, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Expected JSON array');
    }
    // Basic validation: every item must have id, name, family
    const valid = (data as PopularProvider[]).filter(
      (p): p is PopularProvider =>
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.family === 'string',
    );
    return valid.length > 0 ? valid : DEFAULT_POPULAR_PROVIDERS;
  } catch {
    return DEFAULT_POPULAR_PROVIDERS;
  }
}

// ── Provider Key Card ────────────────────────────────────────────────────────

function ProviderKeyCard({
  popular,
  catalogProvider,
  savedProvider,
  onKeySaved,
}: {
  popular: PopularProvider;
  catalogProvider?: CatalogProvider;
  savedProvider?: SavedProvider;
  onKeySaved: (providerId: string) => void;
}) {
  const [key, setKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(!!savedProvider?.apiKeys.some((k) => k.isActive));
  const [showModels, setShowModels] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleSave = async () => {
    if (!key.trim()) return;
    setIsSaving(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      // If the provider doesn't exist yet in the catalog, add it first
      if (!catalogProvider) {
        ws.send({
          type: 'provider.add',
          payload: { id: popular.id, family: popular.family, apiKey: key.trim() },
        });
      } else {
        ws.addKey(popular.id, 'default', key.trim());
      }
      setSaved(true);
      setKey('');
      toast.success(`${popular.name} API key saved`);
      onKeySaved(popular.id);

      // Track the key save event
      trackEvent('provider_key_saved', 'engagement', {
        label: popular.name,
        metadata: {
          providerId: popular.id,
          providerFamily: popular.family,
          hasReferral: !!popular.referral,
          isNewProvider: !catalogProvider,
        },
      });
    } catch {
      toast.error(`Failed to save ${popular.name} API key`);

      // Track the failed save event
      trackEvent('provider_key_save_failed', 'error', {
        label: popular.name,
        metadata: {
          providerId: popular.id,
          providerFamily: popular.family,
        },
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && key.trim()) {
      handleSave();
    }
  };

  const handleCopyReferral = async () => {
    if (!popular.referral) return;
    try {
      await navigator.clipboard.writeText(popular.referral.url);
      setCopied(true);
      toast.success('Referral link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);

      // Track the referral link copy event
      trackEvent('referral_link_copied', 'engagement', {
        label: popular.name,
        metadata: {
          providerId: popular.id,
          referralCode: popular.referral.code,
          referralUrl: popular.referral.url,
        },
      });
    } catch {
      toast.error('Failed to copy referral link');

      // Track the failed copy event
      trackEvent('referral_link_copy_failed', 'error', {
        label: popular.name,
        metadata: {
          providerId: popular.id,
          referralCode: popular.referral.code,
        },
      });
    }
  };

  const hasModels = catalogProvider && catalogProvider.modelCount > 0;

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-all',
        saved
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : `bg-gradient-to-br ${popular.color}`,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl shrink-0 mt-0.5">{popular.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{popular.name}</h3>
            {saved && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <Check className="h-2.5 w-2.5" />
                Key saved
              </span>
            )}
            {popular.referral && !saved && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <Gift className="h-2.5 w-2.5" />
                Referral
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{popular.description}</p>
          {popular.referral && !saved && (
            <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-1">
              🎁 {popular.referral.reward}
            </p>
          )}

          {!saved ? (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder={popular.keyPlaceholder}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="font-mono text-sm"
                />
                <Button
                  onClick={handleSave}
                  disabled={!key.trim() || isSaving}
                  size="sm"
                  className="shrink-0"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
              {popular.docsUrl && (
                <a
                  href={popular.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    trackEvent('provider_docs_link_clicked', 'engagement', {
                      label: popular.name,
                      metadata: {
                        providerId: popular.id,
                        docsUrl: popular.docsUrl,
                        hasReferral: !!popular.referral,
                      },
                    });
                  }}
                >
                  Get your API key <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {popular.referral && (
                <button
                  type="button"
                  onClick={handleCopyReferral}
                  className="inline-flex items-center gap-1 text-[11px] text-amber-600/80 dark:text-amber-400/80 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> Copy referral link
                    </>
                  )}
                </button>
              )}
            </div>
          ) : hasModels ? (
            <button
              type="button"
              onClick={() => setShowModels(!showModels)}
              className="mt-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              {catalogProvider?.modelCount} models available
              {showModels ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Custom Provider Section ─────────────────────────────────────────────────

function CustomProviderSection({ onKeySaved }: { onKeySaved: (providerId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [family, setFamily] = useState<string>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    if (!providerId.trim()) return;
    setIsSaving(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      ws.send({
        type: 'provider.add',
        payload: {
          id: providerId.trim(),
          family,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: key.trim() || undefined,
        },
      });
      toast.success(`Provider "${providerId.trim()}" added`);
      onKeySaved(providerId.trim());
      setProviderId('');
      setBaseUrl('');
      setKey('');
      setExpanded(false);
    } catch {
      toast.error('Failed to add provider');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center">
          <Plus className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium">Custom / Self-hosted Provider</h3>
          <p className="text-xs text-muted-foreground">
            Add any OpenAI-compatible endpoint (Ollama, vLLM, Together, etc.)
          </p>
        </div>
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/40">
          <div className="grid grid-cols-2 gap-3 pt-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                Provider ID *
              </label>
              <Input
                placeholder="e.g. my-llm"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                Family
              </label>
              <select
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
              Base URL (optional)
            </label>
            <Input
              placeholder="e.g. http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
              API Key (optional — some local providers don&apos;t need one)
            </label>
            <Input
              type="password"
              placeholder="API key (if required)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="text-sm font-mono"
            />
          </div>
          <Button onClick={handleSave} disabled={!providerId.trim() || isSaving} size="sm">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Add Provider
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────

export function SetupScreen() {
  const { setCurrentView } = useUIStore();
  const { provider, model, setProvider, setModel, wsConnected, wsUrl } = useConfigStore();
  useWebSocket();

  // Step: 'keys' | 'done'
  const [step, setStep] = useState<'keys' | 'done'>('keys');

  // Catalog data
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [savedProviderIds, setSavedProviderIds] = useState<Set<string>>(new Set());

  // Popular providers loaded from external JSON
  const [popularProviders, setPopularProviders] = useState<PopularProvider[]>(DEFAULT_POPULAR_PROVIDERS);
  const [isLoadingPopular, setIsLoadingPopular] = useState(false);
  const [popularRefreshNonce, setPopularRefreshNonce] = useState(0);
  const [previousProviderCount, setPreviousProviderCount] = useState(0);
  const isInitialLoadRef = useRef(true);

  // Fetch popular providers from remote JSON on mount and when refresh is triggered
  useEffect(() => {
    const controller = new AbortController();
    // Try local file first (dev / self-hosted), then fall back to GitHub raw
    const localUrl = `${window.location.origin}/providers.json`;
    const githubUrl = 'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/webui/public/providers.json';

    setIsLoadingPopular(true);
    loadPopularProviders(localUrl, controller.signal)
      .then((local) => {
        if (local !== DEFAULT_POPULAR_PROVIDERS) {
          setPopularProviders(local);
          setIsLoadingPopular(false);

          // Track successful local load
          trackEvent('providers_loaded', 'system', {
            label: 'local',
            metadata: {
              providerCount: local.length,
              source: localUrl,
            },
          });

          // Show toast notification on refresh (not initial load)
          if (!isInitialLoadRef.current) {
            const diff = local.length - previousProviderCount;
            if (diff > 0) {
              toast.success(`${local.length} providers loaded (${diff} new)`);
            } else if (diff < 0) {
              toast.success(`${local.length} providers loaded (${Math.abs(diff)} removed)`);
            } else {
              toast.success(`${local.length} providers loaded (no changes)`);
            }
            setPreviousProviderCount(local.length);
          }
          return;
        }
        // Local didn't work, try GitHub
        return loadPopularProviders(githubUrl, controller.signal);
      })
      .then((result) => {
        if (result) {
          setPopularProviders(result);

          // Track successful GitHub load
          trackEvent('providers_loaded', 'system', {
            label: 'github',
            metadata: {
              providerCount: result.length,
              source: githubUrl,
            },
          });

          // Show toast notification on refresh (not initial load)
          if (!isInitialLoadRef.current) {
            const diff = result.length - previousProviderCount;
            if (diff > 0) {
              toast.success(`${result.length} providers loaded (${diff} new)`);
            } else if (diff < 0) {
              toast.success(`${result.length} providers loaded (${Math.abs(diff)} removed)`);
            } else {
              toast.success(`${result.length} providers loaded (no changes)`);
            }
            setPreviousProviderCount(result.length);
          }
        }
      })
      .catch(() => {
        /* keep defaults */

        // Track failed load
        trackEvent('providers_load_failed', 'error', {
          metadata: {
            localUrl,
            githubUrl,
          },
        });

        // Show error toast on refresh (not initial load)
        if (!isInitialLoadRef.current) {
          toast.error('Failed to refresh providers');
        }
      })
      .finally(() => {
        setIsLoadingPopular(false);
        isInitialLoadRef.current = false;
      });

    return () => controller.abort();
  }, [popularRefreshNonce]);

  // Selected values (for the done step)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Fetch provider catalog and saved providers on mount
  useEffect(() => {
    if (!wsConnected) return;

    const wsClient = getWSClient(wsUrl);
    let catalogTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      catalogTimeout = null;
      setIsLoadingCatalog(false);
      setCatalogError(
        'The backend is not responding. It may have crashed or the connection dropped.',
      );
    }, 8000);
    const clearCatalogTimeout = () => {
      if (catalogTimeout) {
        clearTimeout(catalogTimeout);
        catalogTimeout = null;
      }
    };

    const off1 = wsClient.on('provider.catalog', (msg: WSServerMessage) => {
      if (msg.type === 'provider.catalog') {
        clearCatalogTimeout();
        setCatalogError(null);
        const payload = msg.payload as { providers: CatalogProvider[] };
        const sorted = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setCatalogProviders(sorted);
        setIsLoadingCatalog(false);
      }
    });

    const off2 = wsClient.on('provider.models', (msg: WSServerMessage) => {
      if (msg.type === 'provider.models') {
        const payload = msg.payload as { provider: string; models: CatalogModel[] };
        setCatalogModels((prev) => ({ ...prev, [payload.provider]: payload.models }));
        setIsLoadingModels(false);

        if (payload.models.length === 1) {
          setSelectedModel(payload.models[0].id);
        } else if (model && payload.models.some((m) => m.id === model)) {
          setSelectedModel(model);
        }
      }
    });

    const off3 = wsClient.on('providers.saved', (msg: WSServerMessage) => {
      if (msg.type === 'providers.saved') {
        const payload = msg.payload as { providers: SavedProvider[] };
        const sorted = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setSavedProviders(sorted);
        // Track which providers have saved keys
        const ids = new Set(
          sorted.filter((p) => p.apiKeys.some((k) => k.isActive)).map((p) => p.id),
        );
        setSavedProviderIds(ids);
      }
    });

    setCatalogError(null);
    setIsLoadingCatalog(true);
    wsClient.listProviders();

    return () => {
      clearCatalogTimeout();
      off1?.();
      off2?.();
      off3?.();
    };
  }, [wsConnected, wsUrl, model, reloadNonce]);

  // Retry catalog fetch
  const handleRetryCatalog = useCallback(() => {
    setCatalogError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  // Refresh popular providers from external JSON
  const handleRefreshProviders = useCallback(() => {
    setPopularRefreshNonce((n) => n + 1);
    trackEvent('providers_refresh_clicked', 'engagement', {
      metadata: {
        currentProviderCount: popularProviders.length,
      },
    });
  }, [popularProviders.length]);

  const handleKeySaved = useCallback((providerId: string) => {
    setSavedProviderIds((prev) => new Set([...prev, providerId]));
  }, []);

  const hasAnyKey = savedProviderIds.size > 0;

  const handleFinishSetup = useCallback(() => {
    if (!hasAnyKey) {
      // If no keys yet, try to use the first saved provider
      if (savedProviders.length > 0) {
        const first = savedProviders[0];
        setSelectedProvider(first.id);
        setStep('done');
      }
      return;
    }
    // Use the first saved provider with an active key
    const firstWithKey = savedProviders.find((p) => p.apiKeys.some((k) => k.isActive));
    if (firstWithKey) {
      setSelectedProvider(firstWithKey.id);
      setStep('done');
    }
  }, [hasAnyKey, savedProviders]);

  // Fetch models when selected provider changes
  useEffect(() => {
    if (!selectedProvider || !wsConnected || step !== 'done') return;
    const wsClient = getWSClient(wsUrl);
    if (!catalogModels[selectedProvider]) {
      setIsLoadingModels(true);
      wsClient.listProviderModels(selectedProvider);
    }
  }, [selectedProvider, wsConnected, wsUrl, catalogModels, step]);

  const currentModels = selectedProvider ? catalogModels[selectedProvider] ?? [] : [];

  const handleStartSession = useCallback(() => {
    if (!selectedProvider || !selectedModel) return;

    setProvider(selectedProvider);
    setModel(selectedModel);

    const wsClient = getWSClient(wsUrl);
    wsClient.switchModel(selectedProvider, selectedModel);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
    };

    const off = wsClient.on('key.operation_result', (msg: WSServerMessage) => {
      const p = (msg as { payload: { success: boolean; message: string } }).payload;
      cleanup();
      off();
      if (p.success) {
        wsClient.newSession();
        setCurrentView('chat');
      } else {
        toast.error(p.message);
      }
    });

    timeoutId = setTimeout(() => {
      cleanup();
      off();
      toast.error('Model switch timed out. Please try again.');
    }, 5000);
  }, [selectedProvider, selectedModel, setProvider, setModel, wsUrl, setCurrentView]);

  // Sort providers: popular ones first, then catalog remainder
  const popularIds = new Set(popularProviders.map((p) => p.id));
  const additionalCatalog = catalogProviders
    .filter((p) => !popularIds.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b bg-card shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary via-primary to-primary/60 flex items-center justify-center">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Welcome to WrongStack</h1>
            <p className="text-xs text-muted-foreground">
              Add at least one API key to get started
            </p>
          </div>
        </div>
        {hasAnyKey && (
          <Button onClick={handleFinishSetup} size="sm">
            Continue
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        )}
      </header>

      {/* Content */}
      <ScrollArea className="flex-1">
        {step === 'keys' ? (
          <div className="p-6 max-w-3xl mx-auto space-y-8">
            {/* Progress steps */}
            <div className="flex items-center gap-2 text-sm">
              <div className="flex items-center gap-1.5 text-primary font-medium">
                <KeyRound className="h-4 w-4" />
                <span>Add API Keys</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Bot className="h-4 w-4" />
                <span>Pick a Model</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Sparkles className="h-4 w-4" />
                <span>Start</span>
              </div>
            </div>

            {/* Security note */}
            <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
              <Shield className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Your keys stay on your machine</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  API keys are encrypted and stored locally. They&apos;re only sent to the
                  provider&apos;s API endpoint — never to us or any third party.
                </p>
              </div>
            </div>

            {/* Popular Providers Grid */}
            {catalogError ? (
              <div className="flex flex-col items-center text-center gap-4 py-12 rounded-xl border border-destructive/30 bg-destructive/5 px-6">
                <div className="w-12 h-12 rounded-xl bg-destructive/10 border border-destructive/30 flex items-center justify-center">
                  <Globe className="h-6 w-6 text-destructive" />
                </div>
                <div>
                  <p className="text-sm font-medium text-destructive">
                    Can&apos;t reach the backend
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                    {catalogError}
                  </p>
                </div>
                <Button onClick={handleRetryCatalog} size="sm" variant="outline">
                  <Loader2 className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                      Popular Providers
                    </h2>
                    <div className="flex items-center gap-2">
                      {isLoadingPopular && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Updating...
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleRefreshProviders}
                        disabled={isLoadingPopular}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Refresh provider list"
                      >
                        <RefreshCw className={cn('h-3 w-3', isLoadingPopular && 'animate-spin')} />
                        Refresh
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {popularProviders.map((p) => (
                      <ProviderKeyCard
                        key={p.id}
                        popular={p}
                        catalogProvider={catalogProviders.find((c) => c.id === p.id)}
                        savedProvider={savedProviders.find((s) => s.id === p.id)}
                        onKeySaved={handleKeySaved}
                      />
                    ))}
                  </div>
                </div>

                {/* Additional providers from catalog */}
                {additionalCatalog.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                      More Providers
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {additionalCatalog.map((p) => (
                        <ProviderKeyCard
                          key={p.id}
                          popular={{
                            id: p.id,
                            name: p.name,
                            description: `${p.family} · ${p.modelCount} models`,
                            icon: '🔗',
                            color:
                              'from-slate-500/20 to-slate-500/5 border-slate-500/30 hover:border-slate-500/50',
                            keyPlaceholder: 'API key',
                            family: p.family,
                          }}
                          catalogProvider={p}
                          savedProvider={savedProviders.find((s) => s.id === p.id)}
                          onKeySaved={handleKeySaved}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom provider */}
                <div className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Self-hosted
                  </h2>
                  <CustomProviderSection onKeySaved={handleKeySaved} />
                </div>
              </>
            )}

            {isLoadingCatalog && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Start button (sticky at bottom) */}
            {hasAnyKey && (
              <div className="sticky bottom-0 bg-background/80 backdrop-blur-sm py-4 -mx-6 px-6 border-t">
                <Button onClick={handleFinishSetup} className="w-full" size="lg">
                  <Bot className="h-4 w-4 mr-2" />
                  Pick a model and start
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        ) : (
          /* Model Selection + Start */
          <div className="p-6 max-w-2xl mx-auto space-y-8">
            {/* Progress steps */}
            <div className="flex items-center gap-2 text-sm">
              <div className="flex items-center gap-1.5 text-emerald-500">
                <Check className="h-4 w-4" />
                <span>Keys</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-1.5 text-primary font-medium">
                <Bot className="h-4 w-4" />
                <span>Pick a Model</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Sparkles className="h-4 w-4" />
                <span>Start</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep('keys')}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Add more keys
            </button>

            {/* Provider selector */}
            <div className="space-y-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                Choose a Provider
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {savedProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedProvider(p.id);
                      setSelectedModel(null);
                    }}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-all text-sm',
                      selectedProvider === p.id
                        ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                        : 'border-border hover:border-primary/40 hover:bg-primary/5',
                    )}
                  >
                    <span className="font-medium">{p.id}</span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {p.apiKeys.filter((k) => k.isActive).length} active key
                      {p.apiKeys.filter((k) => k.isActive).length !== 1 ? 's' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Model list */}
            {selectedProvider && (
              <div className="space-y-3">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Choose a Model
                </h2>
                <p className="text-xs text-muted-foreground">
                  Models available for {selectedProvider}
                </p>
                {isLoadingModels ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : currentModels.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2">
                    {currentModels.map((m) => {
                      const ctx = m.contextWindow
                        ? `${(m.contextWindow / 1_000_000).toFixed(0)}M ctx`
                        : null;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setSelectedModel(m.id)}
                          className={cn(
                            'w-full text-left rounded-xl border p-3 transition-all',
                            'hover:border-primary/40 hover:bg-primary/5',
                            selectedModel === m.id
                              ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                              : 'border-border bg-card',
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-sm">{m.name}</span>
                              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                {ctx && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                    {ctx}
                                  </span>
                                )}
                                {m.capabilities.slice(0, 3).map((cap) => (
                                  <span
                                    key={cap}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                                  >
                                    {cap}
                                  </span>
                                ))}
                              </div>
                            </div>
                            {selectedModel === m.id && (
                              <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                <Check className="h-3 h-3 text-primary-foreground" />
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    No models available. Check your API key and try again.
                  </p>
                )}
              </div>
            )}

            {/* Start button */}
            {selectedProvider && selectedModel && (
              <div className="sticky bottom-0 bg-background/80 backdrop-blur-sm py-4 -mx-6 px-6 border-t">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                  <span>
                    {selectedProvider} / {selectedModel}
                  </span>
                </div>
                <Button onClick={handleStartSession} className="w-full" size="lg">
                  <Bot className="h-4 w-4 mr-2" />
                  Start Session
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
