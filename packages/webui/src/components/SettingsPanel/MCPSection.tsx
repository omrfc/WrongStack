import { toast } from '@/components/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WSServerMessage } from '@/types';
import { type ReactElement, useState, useEffect, useCallback } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import {
  Server,
  Power,
  PowerOff,
  Search,
  Plus,
  Trash2,
  Edit3,
  ChevronDown,
  ChevronRight,
  Loader2,
  Moon,
  Sun,
  Zap,
} from 'lucide-react';

export interface MCPServer {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  error?: string;
  lastError?: string;
  pid?: number;
}

export interface MCPServerConfig {
  name: string;
  transport: string;
  description?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
}

/** Map server status to a human-readable label and color */
function statusInfo(status: MCPServer['status']): { label: string; color: string } {
  switch (status) {
    case 'connected': return { label: 'Connected', color: 'bg-green-500' };
    case 'connecting': return { label: 'Connecting', color: 'bg-yellow-500' };
    case 'sleeping': return { label: 'Sleeping', color: 'bg-blue-500' };
    case 'discovering': return { label: 'Discovering', color: 'bg-purple-500' };
    case 'error': return { label: 'Error', color: 'bg-red-500' };
    case 'stopped': return { label: 'Stopped', color: 'bg-gray-500' };
    default: return { label: 'Unknown', color: 'bg-gray-400' };
  }
}

/** Small colored dot for status indication */
function StatusDot({ status }: { status: MCPServer['status'] }) {
  const { color } = statusInfo(status);
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

/** Expandable server card */
function ServerCard({
  server,
  onWake,
  onSleep,
  onDiscover,
  onEdit,
  onRemove,
}: {
  server: MCPServer;
  onWake: () => void;
  onSleep: () => void;
  onDiscover: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { color } = statusInfo(server.status);

  return (
    <div className="border rounded-lg p-3 bg-card">
      <div className="flex items-center justify-between">
        <button
          className="flex items-center gap-2 flex-1 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <StatusDot status={server.status} />
          <span className="font-medium">{server.name}</span>
          <span className="text-xs text-muted-foreground">{server.transport}</span>
          {!server.enabled && (
            <Badge variant="outline" className="text-xs">Disabled</Badge>
          )}
        </button>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {server.status === 'sleeping' && (
            <Button variant="ghost" size="sm" onClick={onWake} title="Wake server">
              <Sun className="w-4 h-4" />
            </Button>
          )}
          {(server.status === 'connected' || server.status === 'connecting') && (
            <Button variant="ghost" size="sm" onClick={onSleep} title="Sleep server">
              <Moon className="w-4 h-4" />
            </Button>
          )}
          {(server.status === 'stopped' || server.status === 'sleeping') && (
            <Button variant="ghost" size="sm" onClick={onDiscover} title="Discover tools">
              <Search className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
            <Edit3 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} title="Remove" className="text-destructive hover:text-destructive">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pl-6 text-sm space-y-2">
          <div className="grid grid-cols-2 gap-1">
            <span className="text-muted-foreground">Status:</span>
            <span className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
              {statusInfo(server.status).label}
            </span>
            <span className="text-muted-foreground">Enabled:</span>
            <span>{server.enabled ? 'Yes' : 'No'}</span>
            {server.description && (
              <>
                <span className="text-muted-foreground">Description:</span>
                <span>{server.description}</span>
              </>
            )}
            {server.pid && (
              <>
                <span className="text-muted-foreground">PID:</span>
                <span>{server.pid}</span>
              </>
            )}
            {server.error && (
              <>
                <span className="text-muted-foreground">Error:</span>
                <span className="text-destructive">{server.error}</span>
              </>
            )}
          </div>
          {server.tools && server.tools.length > 0 && (
            <div>
              <span className="text-muted-foreground">Tools ({server.tools.length}):</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {server.tools.map((tool) => (
                  <Badge key={tool} variant="secondary" className="text-xs">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {(!server.tools || server.tools.length === 0) && server.status === 'connected' && (
            <span className="text-muted-foreground">No tools discovered yet</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Edit/Add Server Dialog */
function ServerDialog({
  open,
  onOpenChange,
  server,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: MCPServer;
  onSave: (config: MCPServerConfig) => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState(server?.transport ?? 'stdio');
  const [description, setDescription] = useState(server?.description ?? '');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  useEffect(() => {
    if (server) {
      setName(server.name);
      setTransport(server.transport);
      setDescription(server.description ?? '');
      setEnabled(server.enabled);
    } else {
      setName('');
      setTransport('stdio');
      setDescription('');
      setCommand('');
      setArgs('');
      setEnabled(true);
    }
  }, [server, open]);

  const handleSave = () => {
    if (!name.trim()) {
      toast.error('Server name is required');
      return;
    }
    onSave({
      name: name.trim(),
      transport,
      description: description.trim() || undefined,
      enabled,
      command: command.trim() || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{server ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., github, filesystem"
              disabled={!!server}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Transport</label>
            <select
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            >
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
              <option value="http">http</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Command (optional)</label>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g., npx"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Args (optional, space-separated)</label>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g., -y @modelcontextprotocol/server-github"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Description (optional)</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="GitHub MCP server for repository access"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="enabled" className="text-sm">Enable server</label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>{server ? 'Save Changes' : 'Add Server'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MCPSection(): ReactElement {
  const ws = useWebSocket();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'list' | 'add'>('list');
  const [editServer, setEditServer] = useState<MCPServer | undefined>();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [pendingOp, setPendingOp] = useState<string | null>(null);

  // Load server list on mount and when MCP events come in
  useEffect(() => {
    if (!ws.client) return;

    const handleMcpList = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.list') {
        const p = msg.payload as { servers: MCPServer[] };
        setServers(p.servers ?? []);
        setLoading(false);
      }
    };

    const handleMcpServerAdded = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.added') {
        const p = msg.payload as { server: MCPServer };
        setServers((prev) => [...prev.filter((s) => s.name !== p.server.name), p.server]);
        toast.success(`Server "${p.server.name}" added`);
      }
    };

    const handleMcpServerRemoved = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.removed') {
        const p = msg.payload as { name: string };
        setServers((prev) => prev.filter((s) => s.name !== p.name));
        toast.success(`Server "${p.name}" removed`);
      }
    };

    const handleMcpServerUpdated = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.updated') {
        const p = msg.payload as { server: MCPServer };
        setServers((prev) => prev.map((s) => (s.name === p.server.name ? p.server : s)));
      }
    };

    const handleMcpServerDiscovered = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.discovered') {
        const p = msg.payload as { name: string; tools: string[] };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name ? { ...s, status: 'sleeping' as const, tools: p.tools } : s,
          ),
        );
        setPendingOp(null);
        toast.success(`Discovered ${p.tools.length} tools from "${p.name}"`);
      }
    };

    const handleMcpServerSleeping = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.sleeping') {
        const p = msg.payload as { name: string };
        setServers((prev) =>
          prev.map((s) => (s.name === p.name ? { ...s, status: 'sleeping' as const } : s)),
        );
        setPendingOp(null);
        toast.info(`Server "${p.name}" is now sleeping`);
      }
    };

    const handleMcpServerWaking = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.waking') {
        const p = msg.payload as { name: string };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name ? { ...s, status: 'connecting' as const } : s,
          ),
        );
      }
    };

    const handleMcpServerConnected = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.connected') {
        const p = msg.payload as { name: string; pid?: number };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name ? { ...s, status: 'connected', pid: p.pid } : s,
          ),
        );
        setPendingOp(null);
        toast.success(`Server "${p.name}" connected`);
      }
    };

    const handleMcpServerError = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.error') {
        const p = msg.payload as { name: string; error: string };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name ? { ...s, status: 'error', error: p.error } : s,
          ),
        );
        setPendingOp(null);
        toast.error(`Server "${p.name}" error: ${p.error}`);
      }
    };

    const handleMcpOperationResult = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.operation_result') {
        const p = msg.payload as { success: boolean; message: string };
        if (!p.success) {
          toast.error(p.message);
        }
        setPendingOp(null);
      }
    };

    const off1 = ws.client.on('mcp.list', handleMcpList);
    const off2 = ws.client.on('mcp.server.added', handleMcpServerAdded);
    const off3 = ws.client.on('mcp.server.removed', handleMcpServerRemoved);
    const off4 = ws.client.on('mcp.server.updated', handleMcpServerUpdated);
    const off5 = ws.client.on('mcp.server.discovered', handleMcpServerDiscovered);
    const off6 = ws.client.on('mcp.server.sleeping', handleMcpServerSleeping);
    const off7 = ws.client.on('mcp.server.waking', handleMcpServerWaking);
    const off8 = ws.client.on('mcp.server.connected', handleMcpServerConnected);
    const off9 = ws.client.on('mcp.server.error', handleMcpServerError);
    const off10 = ws.client.on('mcp.operation_result', handleMcpOperationResult);

    // Request initial list using proper WS client method
    setLoading(true);
    ws.client?.listMcpServers();

    return () => {
      off1?.();
      off2?.();
      off3?.();
      off4?.();
      off5?.();
      off6?.();
      off7?.();
      off8?.();
      off9?.();
      off10?.();
    };
  }, [ws.client]);

  const handleAdd = useCallback(
    (config: MCPServerConfig) => {
      ws.client?.addMcpServer(config);
      setTab('list');
    },
    [ws],
  );

  const handleRemove = useCallback(
    (name: string) => {
      if (confirm(`Remove server "${name}"?`)) {
        ws.client?.removeMcpServer(name);
      }
    },
    [ws],
  );

  const handleEdit = useCallback(
    (server: MCPServer) => {
      setEditServer(server);
      setShowEditDialog(true);
    },
    [],
  );

  const handleSaveEdit = useCallback(
    (config: MCPServerConfig) => {
      ws.client?.updateMcpServer(config);
    },
    [ws],
  );

  const handleWake = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.wakeMcpServer(name);
    },
    [ws],
  );

  const handleSleep = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.sleepMcpServer(name);
    },
    [ws],
  );

  const handleDiscover = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.discoverMcpServer(name);
    },
    [ws],
  );

  const handleRefresh = useCallback(() => {
    setLoading(true);
    ws.client?.listMcpServers();
  }, [ws]);

  const connectedCount = servers.filter((s) => s.status === 'connected').length;
  const sleepingCount = servers.filter((s) => s.status === 'sleeping').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5" />
          <h2 className="text-lg font-semibold">MCP Servers</h2>
          {servers.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {connectedCount} connected · {sleepingCount} sleeping · {servers.length} total
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Refresh
          </Button>
          <Button size="sm" onClick={() => setTab('add')}>
            <Plus className="w-4 h-4 mr-1" />
            Add Server
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'list' | 'add')}>
        <TabsList>
          <TabsTrigger value="list">Servers</TabsTrigger>
          <TabsTrigger value="add">Add New</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-3">
          {loading && servers.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading servers...
            </div>
          ) : servers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Server className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>No MCP servers configured</p>
              <p className="text-sm">Add a server to get started</p>
            </div>
          ) : (
            servers.map((server) => (
              <ServerCard
                key={server.name}
                server={server}
                onWake={() => handleWake(server.name)}
                onSleep={() => handleSleep(server.name)}
                onDiscover={() => handleDiscover(server.name)}
                onEdit={() => handleEdit(server)}
                onRemove={() => handleRemove(server.name)}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="add">
          <ServerDialog
            open={showEditDialog || tab === 'add'}
            onOpenChange={(open) => {
              setShowEditDialog(false);
              if (!open) setTab('list');
            }}
            onSave={handleAdd}
          />
          <div className="text-sm text-muted-foreground">
            <p>Enter server details to add a new MCP server.</p>
            <p className="mt-1">After adding, use "Discover" to fetch available tools.</p>
          </div>
        </TabsContent>
      </Tabs>

      <ServerDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        server={editServer}
        onSave={handleSaveEdit}
      />
    </div>
  );
}
