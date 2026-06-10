import { toast } from '@/components/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useConfigStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';
import {
  Activity,
  Bot,
  Cpu,
  Globe,
  Layers,
  Monitor,
  Moon,
  Network,
  Palette,
  Puzzle,
  Shield,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../ThemeProvider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { PreferenceToggle } from './PreferenceToggle';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import {
  ProviderSection,
  type CatalogProvider,
  type SavedProvider,
  type ProviderTab,
} from './ProviderSection';
import { ModelSection } from './ModelSection';

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

export function SettingsPanel() {
  const { setCurrentView } = useUIStore();
  const { provider, model, setProvider, setModel, wsConnected } = useConfigStore();
  const { theme, setTheme } = useTheme();
  const ws = useWebSocket();
  const wsClient = ws.client;
  const { updatePrefs, switchAutonomy } = ws;
  const localPrefs = useLocalPrefs();

  // Helper: apply a pref change locally AND push it to the server so the
  // running agent sees the new value immediately. Uses the batch
  // prefs.update message for efficient multi-key updates.
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );

  // Catalog data (unchanged)
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [providerTab, setProviderTab] = useState<ProviderTab>('catalog');
  const [catalogQuery, setCatalogQuery] = useState('');
  const currentCatalogProvider = catalogProviders.find((p) => p.id === provider);

  // WS event subscriptions
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
        if (next.length > 0) setProviderTab('saved');
      }
    };

    if (!wsConnected || !wsClient) return;

    const off1 = wsClient.on('provider.catalog', handleProviderCatalog);
    const off2 = wsClient.on('provider.models', handleProviderModels);
    const off3 = wsClient.on('providers.saved', handleSavedProviders);

    setIsLoadingCatalog(true);
    setIsLoadingSaved(true);
    wsClient.listProviders();
    wsClient.listSavedProviders();

    return () => {
      off1?.();
      off2?.();
      off3?.();
    };
  }, [wsConnected, wsClient]);

  // Provider selection
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

  // Model selection
  const handleModelSelect = useCallback(
    (modelId: string) => {
      setModel(modelId);
      const currentProvider = useConfigStore.getState().provider;
      ws.switchModel?.(currentProvider, modelId);
      toast.success(`Switching to ${currentProvider} / ${modelId}…`);
    },
    [setModel, ws],
  );

  // Key management callbacks
  const handleAddKey = useCallback(
    (providerId: string, label: string, value: string) => {
      ws.addKey?.(providerId, label, value);
    },
    [ws],
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

  const handleAddProvider = useCallback(
    (id: string, family: string, baseUrl?: string | undefined, apiKey?: string) => {
      ws.addProvider?.(id, family, baseUrl, apiKey);
    },
    [ws],
  );

  const handleRemoveProvider = useCallback(
    (providerId: string) => {
      ws.removeProvider?.(providerId);
    },
    [ws],
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
            <TabsList className="w-full justify-start mb-6 grid grid-cols-6">
              <TabsTrigger value="provider" className="gap-1 text-xs">
                <Network className="h-3.5 w-3.5" />
                Provider
              </TabsTrigger>
              <TabsTrigger value="model" className="gap-1 text-xs">
                <Cpu className="h-3.5 w-3.5" />
                Model
              </TabsTrigger>
              <TabsTrigger value="connection" className="gap-1 text-xs">
                <Globe className="h-3.5 w-3.5" />
                Connect
              </TabsTrigger>
              <TabsTrigger value="appearance" className="gap-1 text-xs">
                <Palette className="h-3.5 w-3.5" />
                Look
              </TabsTrigger>
              <TabsTrigger value="agent" className="gap-1 text-xs">
                <Bot className="h-3.5 w-3.5" />
                Agent
              </TabsTrigger>
              <TabsTrigger value="features" className="gap-1 text-xs">
                <Puzzle className="h-3.5 w-3.5" />
                Feat.
              </TabsTrigger>
            </TabsList>

            {/* Provider Tab */}
            <TabsContent value="provider" className="space-y-4">
              <ProviderSection
                activeProvider={provider}
                catalogProviders={catalogProviders}
                isLoadingCatalog={isLoadingCatalog}
                savedProviders={savedProviders}
                isLoadingSaved={isLoadingSaved}
                providerTab={providerTab}
                setProviderTab={setProviderTab}
                onSelectProvider={handleProviderSelect}
                onAddKey={handleAddKey}
                onDeleteKey={handleDeleteKey}
                onSetActiveKey={handleSetActiveKey}
                onAddProvider={handleAddProvider}
                onRemoveProvider={handleRemoveProvider}
                catalogQuery={catalogQuery}
                setCatalogQuery={setCatalogQuery}
              />
            </TabsContent>

            {/* Model Tab */}
            <TabsContent value="model" className="space-y-4">
              <ModelSection
                provider={provider}
                catalogModels={catalogModels}
                currentCatalogProvider={currentCatalogProvider}
                isLoadingModels={isLoadingModels}
                setIsLoadingModels={setIsLoadingModels}
                onModelSelect={handleModelSelect}
                refreshModels={(pid) => ws.listProviderModels?.(pid)}
              />
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
                  URL of the agent WebSocket server. The server runs alongside the CLI.
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

            {/* Appearance Tab — unchanged */}
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

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3">Preferences</h3>
                <PreferenceToggle
                  label="Compact density"
                  hint="Tighter spacing throughout the chat."
                  selector={(s) => s.compactMode}
                  onChange={() => useUIStore.getState().toggleCompactMode()}
                />
                <PreferenceToggle
                  label="Sound on completion"
                  hint="Play a soft chime when a run finishes."
                  selector={null}
                  configKey="soundOnComplete"
                />
              </div>
            </TabsContent>

            {/* Agent Tab */}
            <TabsContent value="agent" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  Autonomy & Behavior
                </h3>
                <PreferenceSelect
                  label="Autonomy mode"
                  hint="How independently the agent proceeds between turns."
                  value={localPrefs.autonomy}
                  options={[
                    { value: 'off' as const, label: 'Off — full manual control' },
                    { value: 'suggest' as const, label: 'Suggest — suggests next steps' },
                    { value: 'auto' as const, label: 'Auto — brief confirmation delay' },
                    { value: 'eternal' as const, label: 'Eternal — autonomous until goal done' },
                    { value: 'eternal-parallel' as const, label: 'Eternal Parallel — multi-agent fleet' },
                  ]}
                  onChange={(v) => {
                    localPrefs.set({ autonomy: v });
                    switchAutonomy(v);
                  }}
                />
                <PreferenceSlider
                  label="Auto-proceed delay"
                  hint="Milliseconds before the agent auto-proceeds in Auto mode. 0 = immediate."
                  value={localPrefs.autonomyDelayMs}
                  min={0}
                  max={10000}
                  step={500}
                  unit="ms"
                  onChange={(v) => syncPref('autonomyDelayMs', v)}
                />
                <PreferenceToggle
                  label="YOLO mode"
                  hint="Bypass tool confirmation prompts — the agent runs without asking."
                  value={localPrefs.yolo}
                  onChange={() => syncPref('yolo', !localPrefs.yolo)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  Execution
                </h3>
                <PreferenceSlider
                  label="Max iterations per run"
                  hint="Hard cap on LLM turns per agent.run()."
                  value={localPrefs.maxIterations}
                  min={10}
                  max={2000}
                  step={10}
                  onChange={(v) => syncPref('maxIterations', v)}
                />
                <PreferenceToggle
                  label="Confirm before exit"
                  hint="First Ctrl+C aborts work, second confirms exit."
                  value={localPrefs.confirmExit}
                  onChange={() => syncPref('confirmExit', !localPrefs.confirmExit)}
                />
                <PreferenceToggle
                  label="Chime on completion"
                  hint="Terminal bell when an agent run finishes."
                  value={localPrefs.chime}
                  onChange={() => syncPref('chime', !localPrefs.chime)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Fleet & Streaming
                </h3>
                <PreferenceToggle
                  label="Stream fleet events"
                  hint="Show live subagent activity in the fleet panel."
                  value={localPrefs.streamFleet}
                  onChange={() => syncPref('streamFleet', !localPrefs.streamFleet)}
                />
                <PreferenceToggle
                  label="Next-step prediction"
                  hint="After a turn completes, predict likely next steps."
                  value={localPrefs.nextPrediction}
                  onChange={() => syncPref('nextPrediction', !localPrefs.nextPrediction)}
                />
              </div>
            </TabsContent>

            {/* Features Tab */}
            <TabsContent value="features" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Puzzle className="h-4 w-4 text-muted-foreground" />
                  Feature Flags
                </h3>
                <PreferenceToggle
                  label="MCP servers"
                  hint="Enable Model Context Protocol integrations."
                  value={localPrefs.featureMcp}
                  onChange={() => syncPref('featureMcp', !localPrefs.featureMcp)}
                />
                <PreferenceToggle
                  label="Plugins"
                  hint="Load and run user-installed plugins."
                  value={localPrefs.featurePlugins}
                  onChange={() => syncPref('featurePlugins', !localPrefs.featurePlugins)}
                />
                <PreferenceToggle
                  label="Memory"
                  hint="Persist and recall facts across sessions."
                  value={localPrefs.featureMemory}
                  onChange={() => syncPref('featureMemory', !localPrefs.featureMemory)}
                />
                <PreferenceToggle
                  label="Skills"
                  hint="Load domain-specific skill prompts."
                  value={localPrefs.featureSkills}
                  onChange={() => syncPref('featureSkills', !localPrefs.featureSkills)}
                />
                <PreferenceToggle
                  label="Models registry"
                  hint="Use the models.dev catalog for provider discovery."
                  value={localPrefs.featureModelsRegistry}
                  onChange={() => syncPref('featureModelsRegistry', !localPrefs.featureModelsRegistry)}
                />
                <PreferenceToggle
                  label="Index on start"
                  hint="Build the codebase symbol index at session start."
                  value={localPrefs.indexOnStart}
                  onChange={() => syncPref('indexOnStart', !localPrefs.indexOnStart)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Context & Debug
                </h3>
                <PreferenceToggle
                  label="Auto-compact context"
                  hint="Automatically trim the context window when near limits."
                  value={localPrefs.contextAutoCompact}
                  onChange={() => syncPref('contextAutoCompact', !localPrefs.contextAutoCompact)}
                />
                <PreferenceSelect
                  label="Context strategy"
                  hint="How aggressively the context window is managed."
                  value={localPrefs.contextStrategy}
                  options={[
                    { value: 'frugal' as const, label: 'Frugal — tight budget, compact early' },
                    { value: 'balanced' as const, label: 'Balanced — moderate trimming' },
                    { value: 'deep' as const, label: 'Deep — keep more history' },
                    { value: 'archival' as const, label: 'Archival — maximum context retention' },
                  ]}
                  onChange={(v) => syncPref('contextStrategy', v)}
                />
                <PreferenceSelect
                  label="Log level"
                  hint="Minimum severity for server-side logging."
                  value={localPrefs.logLevel}
                  options={[
                    { value: 'debug' as const, label: 'Debug — everything' },
                    { value: 'info' as const, label: 'Info — normal flow' },
                    { value: 'warn' as const, label: 'Warn — problems only' },
                    { value: 'error' as const, label: 'Error — failures only' },
                  ]}
                  onChange={(v) => syncPref('logLevel', v)}
                />
                <PreferenceSelect
                  label="Audit level"
                  hint="Detail level for session audit logs."
                  value={localPrefs.auditLevel}
                  options={[
                    { value: 'minimal' as const, label: 'Minimal — errors only' },
                    { value: 'standard' as const, label: 'Standard — tool calls + errors' },
                    { value: 'verbose' as const, label: 'Verbose — every event' },
                  ]}
                  onChange={(v) => syncPref('auditLevel', v)}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}