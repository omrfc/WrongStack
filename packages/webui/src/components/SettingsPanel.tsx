import { useWebSocket } from '@/hooks/useWebSocket';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import { useConfigStore, useUIStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  Monitor,
  Moon,
  Network,
  Palette,
  Plus,
  RefreshCw,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from './ThemeProvider';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  capabilities: string[];
}

interface SavedProvider {
  id: string;
  family?: string;
  baseUrl?: string;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

type ProviderTab = 'catalog' | 'saved';

export function SettingsPanel() {
  const { setCurrentView } = useUIStore();
  const { provider, model, setProvider, setModel, wsConnected } = useConfigStore();
  const { theme, setTheme } = useTheme();
  const ws = useWebSocket();
  const wsClient = ws.client;
  const listProviders = ws.listProviders;
  const listSavedProviders = ws.listSavedProviders;

  // Catalog data
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [operationStatus, setOperationStatus] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Provider tab selection
  const [providerTab, setProviderTab] = useState<ProviderTab>('catalog');

  // New key form
  const [showAddKeyForm, setShowAddKeyForm] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showNewKeyValue, setShowNewKeyValue] = useState(false);

  // New provider form
  const [showAddProviderForm, setShowAddProviderForm] = useState(false);
  const [newProviderId, setNewProviderId] = useState('');
  const [newProviderFamily, setNewProviderFamily] = useState('openai-compatible');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');

  // Current provider config from catalog
  const currentCatalogProvider = catalogProviders.find((p) => p.id === provider);

  // Load catalog and saved providers on mount
  useEffect(() => {
    const handleProviderCatalog = (msg: WSServerMessage) => {
      if (msg.type === 'provider.catalog') {
        const payload = msg.payload as { providers: CatalogProvider[] };
        setCatalogProviders(payload.providers.sort((a, b) => a.id.localeCompare(b.id)));
        setIsLoadingCatalog(false);
      }
    };

    const handleProviderModels = (msg: WSServerMessage) => {
      if (msg.type === 'provider.models') {
        const payload = msg.payload as { provider: string; models: CatalogModel[] };
        setCatalogModels((prev) => ({ ...prev, [payload.provider]: payload.models }));
        setIsLoadingModels(false);
      }
    };

    const handleSavedProviders = (msg: WSServerMessage) => {
      if (msg.type === 'providers.saved') {
        const payload = msg.payload as { providers: SavedProvider[] };
        const next = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setSavedProviders(next);
        setIsLoadingSaved(false);
        // If the user already has registered accounts (the common case after
        // running `wstack auth`), open the Saved tab automatically. Otherwise
        // most of their data would sit one click away on a tab they never
        // visit, behind a catalog list that doesn't include their aliases
        // (e.g. "minimax-coding-plan" isn't in models.dev).
        if (next.length > 0) setProviderTab('saved');
      }
    };

    const handleKeyOperationResult = (msg: WSServerMessage) => {
      if (msg.type === 'key.operation_result') {
        const payload = msg.payload as { success: boolean; message: string };
        setOperationStatus(payload);
        setTimeout(() => setOperationStatus(null), 3000);
        // Refresh saved providers after operation
        listSavedProviders?.();
      }
    };

    // Only subscribe / fetch once the underlying WS is actually connected.
    // SettingsPanel mounts before the WebSocket finishes its handshake, so
    // ws.client is null on the first render and silently dropping the
    // listProviders() call left users staring at "Saved (0)" forever. Keying
    // the effect on wsConnected re-runs it the moment the socket comes up.
    if (!wsConnected || !wsClient) return;

    const off1 = wsClient.on('provider.catalog', handleProviderCatalog);
    const off2 = wsClient.on('provider.models', handleProviderModels);
    const off3 = wsClient.on('providers.saved', handleSavedProviders);
    const off4 = wsClient.on('key.operation_result', handleKeyOperationResult);

    setIsLoadingCatalog(true);
    setIsLoadingSaved(true);
    listProviders?.();
    listSavedProviders?.();

    return () => {
      off1?.();
      off2?.();
      off3?.();
      off4?.();
    };
  }, [wsConnected, wsClient, listProviders, listSavedProviders]);

  // Selecting a provider just loads its model list and stages the pick locally.
  // The actual backend switch fires when the user picks a model — that's the
  // single point where (provider, model) both have meaningful values to send.
  const handleProviderSelect = useCallback(
    (providerId: string) => {
      setProvider(providerId);
      if (!catalogModels[providerId]) {
        setIsLoadingModels(true);
        ws.listProviderModels?.(providerId);
      }
    },
    [catalogModels, setProvider, ws],
  );

  const handleModelSelect = useCallback(
    (modelId: string) => {
      setModel(modelId);
      // Tell the backend to actually swap the agent's provider+model. Backend
      // will rebuild the provider instance, persist the choice to the config
      // file, and broadcast a fresh session.start — useWebSocket's session.start
      // handler then re-syncs our config store so the chip stays in sync.
      ws.switchModel?.(provider, modelId);
      setOperationStatus({ success: true, message: `Switching to ${provider} / ${modelId}…` });
    },
    [setModel, ws, provider],
  );

  const handleAddKey = useCallback(
    (providerId: string) => {
      if (!newKeyLabel.trim() || !newKeyValue.trim()) return;
      ws.addKey?.(providerId, newKeyLabel.trim(), newKeyValue.trim());
      setNewKeyLabel('');
      setNewKeyValue('');
      setShowAddKeyForm(null);
    },
    [ws, newKeyLabel, newKeyValue],
  );

  const handleDeleteKey = useCallback(
    (providerId: string, label: string) => {
      ws.deleteKey?.(providerId, label);
    },
    [ws],
  );

  const handleSetActiveKey = useCallback(
    (providerId: string, label: string) => {
      ws.setActiveKey?.(providerId, label);
    },
    [ws],
  );

  const handleAddProvider = useCallback(() => {
    if (!newProviderId.trim()) return;
    ws.addProvider?.(
      newProviderId.trim(),
      newProviderFamily,
      newProviderBaseUrl || undefined,
      newProviderApiKey || undefined,
    );
    setNewProviderId('');
    setNewProviderFamily('openai-compatible');
    setNewProviderBaseUrl('');
    setNewProviderApiKey('');
    setShowAddProviderForm(false);
  }, [ws, newProviderId, newProviderFamily, newProviderBaseUrl, newProviderApiKey]);

  const handleRemoveProvider = useCallback(
    (providerId: string) => {
      ws.removeProvider?.(providerId);
    },
    [ws],
  );

  // Group catalog by family, with optional text filter applied first. 115+
  // providers in the catalog made scrolling alone impractical.
  const [catalogQuery, setCatalogQuery] = useState('');
  const families = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
  const filteredCatalog = catalogQuery.trim()
    ? catalogProviders.filter((p) => {
        const q = catalogQuery.trim().toLowerCase();
        return (
          p.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.family.toLowerCase().includes(q)
        );
      })
    : catalogProviders;
  const catalogByFamily = filteredCatalog.reduce(
    (acc, p) => {
      if (!acc[p.family]) acc[p.family] = [];
      acc[p.family]!.push(p);
      return acc;
    },
    {} as Record<string, CatalogProvider[]>,
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b bg-card shrink-0">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Button variant="ghost" size="icon" onClick={() => setCurrentView('chat')}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-2xl mx-auto">
          <Tabs defaultValue="provider">
            <TabsList className="w-full justify-start mb-6 grid grid-cols-4">
              <TabsTrigger value="provider" className="gap-2">
                <Network className="h-4 w-4" />
                Provider
              </TabsTrigger>
              <TabsTrigger value="model" className="gap-2">
                <Cpu className="h-4 w-4" />
                Model
              </TabsTrigger>
              <TabsTrigger value="connection" className="gap-2">
                <Globe className="h-4 w-4" />
                Connection
              </TabsTrigger>
              <TabsTrigger value="appearance" className="gap-2">
                <Palette className="h-4 w-4" />
                Appearance
              </TabsTrigger>
            </TabsList>

            {/* Provider Tab */}
            <TabsContent value="provider" className="space-y-4">
              {/* Provider source toggle */}
              <div className="flex gap-2 mb-4">
                <Button
                  variant={providerTab === 'catalog' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setProviderTab('catalog')}
                >
                  <Globe className="h-4 w-4 mr-1" />
                  Catalog
                </Button>
                <Button
                  variant={providerTab === 'saved' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setProviderTab('saved')}
                >
                  <Key className="h-4 w-4 mr-1" />
                  Saved ({savedProviders.length})
                </Button>
              </div>

              {operationStatus && (
                <div
                  className={cn(
                    'p-3 rounded-lg mb-4 flex items-center gap-2',
                    operationStatus.success
                      ? 'bg-green-500/10 text-green-600'
                      : 'bg-red-500/10 text-red-600',
                  )}
                >
                  {operationStatus.success ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {operationStatus.message}
                </div>
              )}

              {/* Catalog View */}
              {providerTab === 'catalog' && (
                <div className="space-y-4">
                  {/* Search */}
                  <Input
                    placeholder={`Search ${catalogProviders.length} providers (name / id / family)…`}
                    value={catalogQuery}
                    onChange={(e) => setCatalogQuery(e.target.value)}
                    className="text-sm"
                  />
                  {isLoadingCatalog && catalogProviders.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-muted-foreground">Loading catalog...</span>
                    </div>
                  ) : filteredCatalog.length === 0 && catalogQuery ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No providers match "<span className="font-mono">{catalogQuery}</span>".
                    </div>
                  ) : (
                    <>
                      {families.map((family) => {
                        const providers = catalogByFamily[family];
                        if (!providers?.length) return null;
                        return (
                          <div key={family} className="space-y-2">
                            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                              {family}
                            </h3>
                            <div className="grid grid-cols-1 gap-2">
                              {providers.map((p) => (
                                <button
                                  type="button"
                                  key={p.id}
                                  onClick={() => handleProviderSelect(p.id)}
                                  className={cn(
                                    'flex flex-col items-start p-3 rounded-lg border text-left transition-all',
                                    provider === p.id
                                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                      : 'border-border hover:bg-muted',
                                  )}
                                >
                                  <div className="flex w-full justify-between items-start">
                                    <div>
                                      <span className="font-medium">{p.name}</span>
                                      <span className="ml-2 text-xs text-muted-foreground">
                                        ({p.id})
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {p.hasApiKey && (
                                        <span className="text-xs bg-green-500/10 text-green-600 px-2 py-0.5 rounded">
                                          <Key className="h-3 w-3 inline mr-1" />
                                          Configured
                                        </span>
                                      )}
                                      {p.envVars[0] && (
                                        <span className="text-xs text-muted-foreground">
                                          ENV: {p.envVars[0]}
                                        </span>
                                      )}
                                      {provider === p.id && (
                                        <CheckCircle2 className="h-4 w-4 text-primary" />
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-1">
                                    {p.modelCount} models
                                    {p.apiBase && ` · ${p.apiBase}`}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}

              {/* Saved Providers View */}
              {providerTab === 'saved' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-muted-foreground">
                      Manage your API keys and provider configurations
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAddProviderForm(!showAddProviderForm)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Provider
                    </Button>
                  </div>

                  {/* Add Provider Form */}
                  {showAddProviderForm && (
                    <div className="p-4 border rounded-lg space-y-3 bg-muted/50">
                      <h4 className="font-medium">Add Custom Provider</h4>
                      <Input
                        placeholder="Provider ID (e.g. my-llm-server)"
                        value={newProviderId}
                        onChange={(e) => setNewProviderId(e.target.value)}
                      />
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={newProviderFamily}
                        onChange={(e) => setNewProviderFamily(e.target.value)}
                      >
                        <option value="anthropic">Anthropic</option>
                        <option value="openai">OpenAI</option>
                        <option value="openai-compatible">OpenAI Compatible</option>
                        <option value="google">Google</option>
                      </select>
                      <Input
                        placeholder="Base URL (optional, e.g. http://localhost:11434/v1)"
                        value={newProviderBaseUrl}
                        onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                      />
                      <Input
                        type="password"
                        placeholder="API Key (optional)"
                        value={newProviderApiKey}
                        onChange={(e) => setNewProviderApiKey(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleAddProvider}
                          disabled={!newProviderId.trim()}
                        >
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowAddProviderForm(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {isLoadingSaved ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : savedProviders.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No saved providers yet</p>
                      <p className="text-sm">Add a provider to get started</p>
                    </div>
                  ) : (
                    savedProviders.map((sp) => (
                      <div key={sp.id} className="border rounded-lg p-4 space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="font-medium">{sp.id}</h4>
                            {sp.family && (
                              <span className="text-xs text-muted-foreground">{sp.family}</span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleRemoveProvider(sp.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>

                        {sp.baseUrl && (
                          <div className="text-xs text-muted-foreground">
                            <Globe className="h-3 w-3 inline mr-1" />
                            {sp.baseUrl}
                          </div>
                        )}

                        {/* API Keys */}
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium">API Keys</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setShowAddKeyForm(showAddKeyForm === sp.id ? null : sp.id)
                              }
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Add Key
                            </Button>
                          </div>

                          {sp.apiKeys.length === 0 && !showAddKeyForm && (
                            <p className="text-xs text-muted-foreground">No keys configured</p>
                          )}

                          {sp.apiKeys.map((key) => (
                            <div
                              key={key.label}
                              className="flex items-center justify-between p-2 bg-muted/50 rounded"
                            >
                              <div>
                                <span className="text-sm font-medium">{key.label}</span>
                                {key.isActive && (
                                  <span className="ml-2 text-xs bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded">
                                    Active
                                  </span>
                                )}
                                <div className="text-xs text-muted-foreground font-mono">
                                  {key.maskedKey}
                                </div>
                              </div>
                              <div className="flex gap-1">
                                {!key.isActive && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSetActiveKey(sp.id, key.label)}
                                  >
                                    Set Active
                                  </Button>
                                )}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleDeleteKey(sp.id, key.label)}
                                >
                                  <Trash2 className="h-3 w-3 text-destructive" />
                                </Button>
                              </div>
                            </div>
                          ))}

                          {/* Add Key Form */}
                          {showAddKeyForm === sp.id && (
                            <div className="p-3 border rounded space-y-2 bg-background">
                              <Input
                                placeholder="Key label (e.g. default, production)"
                                value={newKeyLabel}
                                onChange={(e) => setNewKeyLabel(e.target.value)}
                              />
                              <div className="flex gap-2">
                                <Input
                                  type={showNewKeyValue ? 'text' : 'password'}
                                  placeholder="API key"
                                  value={newKeyValue}
                                  onChange={(e) => setNewKeyValue(e.target.value)}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setShowNewKeyValue(!showNewKeyValue)}
                                >
                                  {showNewKeyValue ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => handleAddKey(sp.id)}
                                  disabled={!newKeyLabel.trim() || !newKeyValue.trim()}
                                >
                                  Save Key
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setShowAddKeyForm(null);
                                    setNewKeyLabel('');
                                    setNewKeyValue('');
                                  }}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </TabsContent>

            {/* Model Tab */}
            <TabsContent value="model" className="space-y-4">
              {provider ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">
                        {currentCatalogProvider?.name || provider}
                      </p>
                      <p className="text-xs text-muted-foreground">{provider}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsLoadingModels(true);
                        ws.listProviderModels?.(provider);
                      }}
                    >
                      <RefreshCw className={cn('h-4 w-4', isLoadingModels && 'animate-spin')} />
                    </Button>
                  </div>

                  {isLoadingModels && !catalogModels[provider] ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-muted-foreground">Loading models...</span>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {(catalogModels[provider] || []).map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          onClick={() => handleModelSelect(m.id)}
                          className={cn(
                            'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all',
                            model === m.id
                              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                              : 'border-border hover:bg-muted',
                          )}
                        >
                          <div>
                            <span className="font-medium">{m.name || m.id}</span>
                            <div className="flex gap-2 mt-1">
                              {m.capabilities.map((cap) => (
                                <span key={cap} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                                  {cap}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            {m.contextWindow && <div>{m.contextWindow / 1000}k context</div>}
                            {m.inputCost && m.outputCost && (
                              <div>
                                ${m.inputCost}/${m.outputCost}
                              </div>
                            )}
                            {model === m.id && (
                              <CheckCircle2 className="h-4 w-4 text-primary mt-1" />
                            )}
                          </div>
                        </button>
                      ))}

                      {catalogModels[provider]?.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No models found for this provider. The catalog might be empty or still
                          loading.
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Cpu className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>Select a provider first</p>
                </div>
              )}
            </TabsContent>

            {/* Connection Tab */}
            <TabsContent value="connection" className="space-y-4">
              <div className="space-y-3">
                <label
                  htmlFor="websocket-url"
                  className="text-sm font-medium flex items-center gap-2"
                >
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  WebSocket Server URL
                </label>
                <Input
                  id="websocket-url"
                  value={useConfigStore.getState().wsUrl}
                  onChange={(e) => useConfigStore.getState().setConfig({ wsUrl: e.target.value })}
                  placeholder="ws://localhost:3457"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  URL of the WrongStack WebSocket server. The server runs alongside the CLI.
                </p>
              </div>

              <div className="p-4 rounded-lg border bg-muted/50">
                <h4 className="text-sm font-medium mb-2">Starting the WebSocket Server</h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Standalone: run <code className="bg-muted px-1 py-0.5 rounded">./dev.ps1</code>{' '}
                  from the repo root, or set WS_HOST/WS_PORT before launching{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">
                    node packages/webui/dist/server/entry.js
                  </code>
                  . Or alongside the CLI:{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">wstack --webui</code>.
                </p>
              </div>
            </TabsContent>

            {/* Appearance Tab */}
            <TabsContent value="appearance" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3">Theme</h3>
                <div className="grid grid-cols-3 gap-2 max-w-md">
                  <Button
                    variant={theme === 'light' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('light')}
                  >
                    <Sun className="h-4 w-4 mr-1" />
                    Light
                  </Button>
                  <Button
                    variant={theme === 'dark' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('dark')}
                  >
                    <Moon className="h-4 w-4 mr-1" />
                    Dark
                  </Button>
                  <Button
                    variant={theme === 'system' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('system')}
                  >
                    <Monitor className="h-4 w-4 mr-1" />
                    System
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  System follows your OS-level light/dark preference.
                </p>
              </div>

              {/* Preferences — surfaces the persisted toggles that until
                  now were only reachable via Command Palette / Ctrl+Shift+D.
                  Keeps them discoverable and centralizes per-user knobs in
                  one obvious place. Reads & writes via the live stores so
                  changes take effect immediately. */}
              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3">Preferences</h3>
                <PreferenceToggle
                  label="Compact density"
                  hint="Tighter spacing throughout the chat. Toggle anywhere with Ctrl+Shift+D."
                  selector={(s) => s.compactMode}
                  onChange={() => useUIStore.getState().toggleCompactMode()}
                />
                <PreferenceToggle
                  label="Sound on completion"
                  hint="Play a soft chime when a run finishes — useful when working in another tab."
                  selector={null /* config-store path, see component */}
                  configKey="soundOnComplete"
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * One row in the Preferences section. Renders a label / hint pair on the
 * left and a small switch on the right. Source-of-truth selection is
 * pluggable: pass `selector` for a UI-store-backed flag, or `configKey`
 * to bind to a `useConfigStore` boolean (we only handle `soundOnComplete`
 * today but the shape leaves room for more without growing the API).
 */
function PreferenceToggle({
  label,
  hint,
  selector,
  onChange,
  configKey,
}: {
  label: string;
  hint?: string;
  selector: ((s: ReturnType<typeof useUIStore.getState>) => boolean) | null;
  onChange?: () => void;
  configKey?: 'soundOnComplete';
}) {
  const uiVal = useUIStore((s) => (selector ? selector(s) : false));
  const cfgVal = useConfigStore((s) => (configKey ? (s[configKey] as boolean) : false));
  const on = selector ? uiVal : cfgVal;
  const handleToggle = () => {
    if (selector) onChange?.();
    else if (configKey === 'soundOnComplete') {
      const next = !useConfigStore.getState().soundOnComplete;
      useConfigStore.getState().setSoundOnComplete(next);
      // Audible "yes you turned it on" — same logic as the Command Palette
      // toggle so users get the gesture-permission unlock for Web Audio.
      if (next) {
        playCompletionChime();
      }
    }
  };
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={handleToggle}
        className={cn(
          'shrink-0 relative inline-flex h-5 w-9 rounded-full border transition-colors',
          on ? 'bg-primary border-primary' : 'bg-muted border-input hover:bg-muted/80',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-transform',
            on && 'translate-x-4',
          )}
        />
      </button>
    </div>
  );
}
