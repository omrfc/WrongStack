/**
 * AgentFlowViz — Cinematic real-time agent ecosystem visualization.
 *
 * Renders a living graph of the WrongStack agent ecosystem with animated
 * particle flows, glowing nodes, and a real-time HUD. Also handles cross-
 * process fleet snapshots so you see ALL sessions & agents across projects.
 *
 * Interaction:
 *   - Wheel: zoom at cursor position
 *   - Ctrl+drag or middle-mouse: pan
 *   - Click node: show event detail
 *   - HUD: pause / clear / reset zoom
 *
 * Architecture:
 *   Layer 0 (back)  → Canvas: cosmic background + grid
 *   Layer 1          → Canvas: bezier edges between nodes
 *   Layer 2          → Canvas: flowing particle streams
 *   Layer 3          → DOM: absolutely positioned node divs
 *   Layer 4 (front)  → DOM: HUD overlay with stats
 */

import { useVizStore, type VizEvent, type VizNode } from '@/stores/viz-store';
import { cn } from '@/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './AgentFlowViz.css';

// ── Constants ─────────────────────────────────────────────────────────

const GRID_SIZE = 60;
const PARTICLE_COUNT = 80;
const EDGE_FADE_MS = 15_000;
const NODE_LINGER_MS = 60_000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

type Zone = 'left' | 'center-left' | 'center-right' | 'right' | 'top' | 'bottom';
const ZONE_CONFIG: Record<Zone, { x: (order: number) => number; y: (order: number) => number; baseW: number; baseH: number }> = {
  left:         { x: () => 120, y: (o) => 180 + o * 140, baseW: 180, baseH: 80 },
  'center-left':{ x: () => 380, y: (o) => 160 + o * 130, baseW: 200, baseH: 90 },
  'center-right':{ x: () => 680, y: (o) => 180 + o * 120, baseW: 170, baseH: 75 },
  right:        { x: () => 920, y: (o) => 200 + o * 110, baseW: 160, baseH: 70 },
  top:          { x: (o) => 200 + o * 200, y: () => 60, baseW: 150, baseH: 60 },
  bottom:       { x: (o) => 250 + o * 180, y: () => 520, baseW: 160, baseH: 60 },
};

// Fleet zone constants
const FLEET_COL_W = 220;
const FLEET_COL_GAP = 40;
const FLEET_AGENT_H = 60;
const FLEET_SESSION_H = 50;
function fleetX(col: number): number { return 1200 + col * (FLEET_COL_W + FLEET_COL_GAP); }
function fleetSessionY(order: number): number { return 120 + order * (FLEET_SESSION_H + FLEET_AGENT_H * 3 + 40); }

function nodeZone(node: VizNode): Zone {
  if (node.kind === 'provider') return 'left';
  if (node.kind === 'mailbox') return 'top';
  if (node.kind === 'session') return 'bottom';
  if (node.kind === 'tool') return 'center-right';
  return 'center-left';
}

// ── Particle system ───────────────────────────────────────────────────

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: string;
  speed: number;
}

function createParticles(count: number, w: number, h: number): Particle[] {
  const arr: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const maxLife = 60 + Math.random() * 180;
    const colors = [
      'hsla(180,80%,65%,0.6)', 'hsla(280,80%,70%,0.6)',
      'hsla(40,90%,60%,0.6)', 'hsla(0,0%,50%,0.4)',
    ];
    arr.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3 - 0.1,
      life: Math.random() * maxLife, maxLife,
      size: 1 + Math.random() * 2,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      speed: 0.5 + Math.random() * 1.5,
    });
  }
  return arr;
}

// ── Node position ─────────────────────────────────────────────────────

interface NodePos { x: number; y: number; w: number; h: number }

function computeNodePos(node: VizNode, all: VizNode[]): NodePos {
  const zone = nodeZone(node);
  const same = all.filter((n) => nodeZone(n) === zone);
  const order = same.indexOf(node);
  const cfg = ZONE_CONFIG[zone];
  return { x: cfg.x(order), y: cfg.y(order), w: cfg.baseW, h: cfg.baseH };
}

function computeFleetPos(node: VizNode, sessions: VizNode[], agents: VizNode[]): NodePos {
  if (node.kind === 'session') {
    const idx = sessions.indexOf(node);
    return { x: fleetX(0), y: fleetSessionY(idx), w: FLEET_COL_W, h: FLEET_SESSION_H };
  }
  const sIdx = sessions.findIndex((s) => s.sessionId === node.sessionId);
  const agentsInSession = agents.filter((a) => a.sessionId === node.sessionId);
  const aIdx = agentsInSession.indexOf(node);
  return {
    x: fleetX(0) + 20,
    y: fleetSessionY(sIdx >= 0 ? sIdx : 0) + FLEET_SESSION_H + 10 + aIdx * FLEET_AGENT_H,
    w: FLEET_COL_W - 40,
    h: FLEET_AGENT_H - 6,
  };
}

// ── HudStat ───────────────────────────────────────────────────────────

function HudStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="hud-stat">
      <span className="text-[8px] tracking-widest text-white/30 uppercase">{label}</span>
      <span className="text-sm font-bold font-mono" style={{ color }}>{value}</span>
    </div>
  );
}

// ── NodeIcon ──────────────────────────────────────────────────────────

function NodeIcon({ kind, color }: { kind: string; color: string }) {
  const s = { color, fill: 'none', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'provider':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5">
          <circle cx="12" cy="12" r="8" {...s} />
          <path d="M12 4v16M4 12h16" {...s} opacity={0.5} />
          <circle cx="12" cy="12" r="3" fill={color} fillOpacity={0.3} stroke={color} />
        </svg>
      );
    case 'agent':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5">
          <circle cx="12" cy="8" r="4" {...s} />
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" {...s} />
          <circle cx="12" cy="8" r="2" fill={color} fillOpacity={0.4} stroke={color} />
        </svg>
      );
    case 'tool':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a1 1 0 0 0 0-1.4L19.9 2.5a1 1 0 0 0-1.4 0l-3.8 3.8z" {...s} />
          <path d="M9.5 9.5L3 16v5h5l6.5-6.5" {...s} />
          <path d="M9.5 9.5l3.5 3.5" {...s} opacity={0.3} />
        </svg>
      );
    case 'mailbox':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5">
          <rect x="2" y="4" width="20" height="16" rx="2" {...s} />
          <path d="M22 7l-10 7L2 7" {...s} />
          <circle cx="12" cy="12" r="2" fill={color} fillOpacity={0.3} stroke={color} />
        </svg>
      );
    case 'session':
    case 'system':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5">
          <rect x="3" y="3" width="18" height="18" rx="2" {...s} />
          <circle cx="12" cy="12" r="3" fill={color} fillOpacity={0.3} stroke={color} />
          <path d="M12 3v18M3 12h18" {...s} opacity={0.2} />
        </svg>
      );
    default:
      return <div className="w-5 h-5 rounded-full" style={{ background: color, opacity: 0.3 }} />;
  }
}

// ── FleetSessionNode ──────────────────────────────────────────────────

function FleetSessionNode({ node, sessions, agents, onClick }: {
  node: VizNode; sessions: VizNode[]; agents: VizNode[]; onClick: () => void;
}) {
  const pos = computeFleetPos(node, sessions, agents);
  const isRunning = node.status === 'active';
  return (
    <div
      className="absolute rounded-lg border pointer-events-auto cursor-pointer select-none overflow-hidden"
      style={{
        left: pos.x, top: pos.y, width: pos.w, height: pos.h,
        borderColor: node.color,
        background: `linear-gradient(135deg, ${node.color}20, ${node.color}08)`,
        boxShadow: isRunning ? `0 0 15px ${node.color}30` : 'none',
      }}
      onClick={onClick}
      title={`Session: ${node.label}`}
    >
      <div className="flex items-center gap-1.5 px-2 h-full">
        <NodeIcon kind="session" color={node.color} />
        <span className="text-[10px] font-semibold truncate" style={{ color: node.color }}>{node.label}</span>
        <span className="text-[8px] text-white/30 ml-auto">{node.sublabel}</span>
        {isRunning && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: node.color, boxShadow: `0 0 6px ${node.color}` }} />}
      </div>
    </div>
  );
}

// ── FleetAgentNode ────────────────────────────────────────────────────

function FleetAgentNode({ node, sessions, agents, onClick }: {
  node: VizNode; sessions: VizNode[]; agents: VizNode[]; onClick: () => void;
}) {
  const pos = computeFleetPos(node, sessions, agents);
  const isActive = node.status === 'active' || node.status === 'streaming';
  const isError = node.status === 'error';
  return (
    <div
      className={cn(
        'absolute rounded-md border pointer-events-auto cursor-pointer select-none',
        'flex items-center gap-1.5 px-2 transition-all duration-500 overflow-hidden',
        isActive && 'node-pulse', isError && 'node-error-pulse',
      )}
      style={{
        left: pos.x, top: pos.y, width: pos.w, height: pos.h,
        borderColor: node.color,
        background: isActive ? `linear-gradient(90deg, ${node.color}18, ${node.color}06)` : `${node.color}06`,
        boxShadow: isActive ? `0 0 10px ${node.color}20` : 'none',
      }}
      onClick={onClick}
      title={`${node.label} (${node.status})`}
    >
      <NodeIcon kind="agent" color={node.color} />
      <div className="flex flex-col overflow-hidden min-w-0 flex-1">
        <span className="text-[10px] font-medium truncate" style={{ color: node.color }}>{node.label}</span>
        <div className="flex items-center gap-1.5">
          {node.currentTool && <span className="text-[7px] font-mono text-amber-400/70 truncate">{node.currentTool}</span>}
          {node.iterations !== undefined && node.iterations > 0 && <span className="text-[7px] font-mono text-white/30">{node.iterations}it</span>}
        </div>
      </div>
      {node.ctxPct !== undefined && node.ctxPct > 0 && (
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className="text-[7px] font-mono text-cyan-400/50">{node.ctxPct}%</span>
          <div className="w-8 h-1 rounded-full bg-white/5 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{
              width: `${Math.min(100, node.ctxPct)}%`,
              background: node.ctxPct > 80 ? 'hsl(0, 80%, 55%)' : node.ctxPct > 60 ? 'hsl(40, 90%, 55%)' : node.color,
            }} />
          </div>
        </div>
      )}
      {node.costUsd !== undefined && node.costUsd > 0 && (
        <span className="text-[7px] font-mono text-green-400/50 shrink-0">${node.costUsd.toFixed(4)}</span>
      )}
      {isActive && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: node.color, boxShadow: `0 0 6px ${node.color}` }} />}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function AgentFlowViz({ className }: { className?: string | undefined }) {
  const { events, nodes, edges, counters, decayActivity, upsertNode, upsertEdge } = useVizStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 1200, h: 700 });
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number>(0);
  const [paused, setPaused] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<VizEvent | null>(null);

  // ── Pan / Zoom state ──
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const resetZoom = useCallback(() => setTransform({ x: 0, y: 0, scale: 1 }), []);
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0, dragging: false });
  const isPanning = useRef(false);

  // ── Resize ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setDim({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Mouse handlers for pan/zoom ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setTransform((prev) => {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.scale * factor));
      const newX = mx - (mx - prev.x) * (newScale / prev.scale);
      const newY = my - (my - prev.y) * (newScale / prev.scale);
      return { x: newX, y: newY, scale: newScale };
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      isPanning.current = true;
      setTransform((prev) => {
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: prev.x, origY: prev.y, dragging: false };
        return prev;
      });
    }
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isPanning.current) return;
      const d = dragRef.current;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.dragging = true;
      if (!d.dragging) return;
      setTransform((prev) => ({ ...prev, x: d.origX + dx, y: d.origY + dy }));
    };
    const onUp = () => { isPanning.current = false; dragRef.current.dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Sync nodes from events ──
  useEffect(() => {
    if (events.length === 0) return;
    for (const ev of events.slice(0, 5)) {
      switch (ev.kind) {
        case 'provider:call':
        case 'provider:response':
        case 'provider:delta':
          upsertNode({ id: 'provider', kind: 'provider', label: 'LLM', sublabel: (ev.data?.model as string) || '', status: 'active', color: 'hsl(180, 80%, 55%)', activity: 1, provider: ev.data?.provider as string, model: ev.data?.model as string });
          break;
        case 'agent:spawned': {
          const aId = ev.source;
          upsertNode({ id: aId, kind: 'agent', label: (ev.data?.name as string) || aId, sublabel: ev.data?.description as string, status: 'active', color: 'hsl(280, 80%, 65%)', activity: 1, sessionId: ev.data?.sessionId as string, provider: ev.data?.provider as string, model: ev.data?.model as string });
          upsertEdge({ id: `${aId}→session`, source: aId, target: 'session', kind: 'agent:spawned', label: '', intensity: 0.6, color: 'hsl(280, 80%, 40%)' });
          break;
        }
        case 'agent:tool': {
          const agId = ev.source;
          upsertNode({ id: agId, kind: 'agent', label: agId, status: 'active', activity: 1, currentTool: ev.label });
          upsertNode({ id: ev.target ?? 'tool', kind: 'tool', label: ev.target ?? 'tool', status: 'active', activity: 0.8 });
          upsertEdge({ id: `${agId}→${ev.target}`, source: agId, target: ev.target ?? 'tool', kind: 'agent:tool', label: ev.label, intensity: 1, color: 'hsl(40, 90%, 55%)', totalMagnitude: ev.magnitude });
          break;
        }
        case 'agent:status':
          upsertNode({ id: ev.source, kind: 'agent', label: ev.source, status: ev.label.includes('success') ? 'completed' : 'error', activity: 0.5 });
          break;
        case 'tool:started':
          upsertNode({ id: ev.source, kind: 'tool', label: ev.source, status: 'active', activity: 1 });
          break;
        case 'tool:executed':
          upsertNode({ id: ev.source, kind: 'tool', label: ev.source, status: 'idle', activity: 0.3 });
          break;
        case 'mailbox:send':
        case 'mailbox:deliver':
          upsertNode({ id: ev.source, kind: 'mailbox', label: ev.source, status: 'active', activity: 0.8 });
          upsertNode({ id: ev.target ?? 'mb', kind: 'mailbox', label: ev.target ?? 'mb', status: 'active', activity: 0.6 });
          upsertEdge({ id: `mb:${ev.source}→${ev.target}`, source: ev.source, target: ev.target ?? 'mb', kind: 'mailbox:send', label: ev.label, intensity: 0.8, color: 'hsl(140, 70%, 55%)' });
          break;
        case 'error':
          upsertNode({ id: ev.source, kind: 'agent', label: ev.source, status: 'error', activity: 1, color: 'hsl(0, 80%, 55%)' });
          break;

        // ── Fleet snapshot ──
        case 'fleet:snapshot': {
          const sessionsData = ev.data?.sessions as Array<Record<string, unknown>> ?? [];
          for (const s of sessionsData) {
            const sid = `fleet:${s.sessionId as string}`;
            const proj = s.projectName as string;
            const status = s.status as string;
            upsertNode({ id: sid, kind: 'session', label: proj || (s.sessionId as string).slice(0, 12), sublabel: (s.workingDir as string)?.split(/[/\\]/).pop() || '', status: status === 'running' ? 'active' : 'idle', activity: status === 'running' ? 0.8 : 0.2, color: 'hsl(220, 80%, 60%)', sessionId: s.sessionId as string });
            const agentsData = s.agents as Array<Record<string, unknown>> ?? [];
            for (const a of agentsData) {
              const aid = `fleet:agent:${a.id as string}`;
              const aName = a.name as string || (a.id as string);
              const aStatus = a.status as string;
              const isRunning = aStatus === 'running' || aStatus === 'active';
              upsertNode({ id: aid, kind: 'agent', label: aName, status: isRunning ? 'active' : aStatus === 'error' ? 'error' : 'idle', activity: isRunning ? 0.9 : 0.2, color: isRunning ? 'hsl(280, 80%, 65%)' : 'hsl(280, 20%, 40%)', sessionId: sid, currentTool: a.currentTool as string, costUsd: a.costUsd as number, ctxPct: a.ctxPct as number, maxContext: a.maxContext as number, iterations: a.iterations as number, toolCalls: a.toolCalls as number });
              upsertEdge({ id: `${aid}→${sid}`, source: aid, target: sid, kind: 'agent:spawned', label: '', intensity: isRunning ? 0.5 : 0.1, color: isRunning ? 'hsl(280, 80%, 40%)' : 'hsl(280, 20%, 20%)' });
            }
          }
          break;
        }
      }
    }
  }, [events, upsertNode, upsertEdge]);

  // ── Animation loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = dim.w;
    canvas.height = dim.h;

    if (particlesRef.current.length === 0) {
      particlesRef.current = createParticles(PARTICLE_COUNT, dim.w, dim.h);
    }

    let running = true;
    const frame = () => {
      if (!running || paused) { animFrameRef.current = requestAnimationFrame(frame); return; }
      const { w, h } = dim;
      const { x: tx, y: ty, scale } = transform;

      ctx.clearRect(0, 0, w, h);

      // Background (screen-space)
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 100, w / 2, h / 2, Math.max(w, h) * 0.7);
      bgGrad.addColorStop(0, 'hsl(260, 25%, 10%)');
      bgGrad.addColorStop(0.5, 'hsl(240, 20%, 7%)');
      bgGrad.addColorStop(1, 'hsl(220, 30%, 4%)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // ── Camera transform ──
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(scale, scale);

      // Grid
      ctx.strokeStyle = 'hsla(260, 30%, 30%, 0.06)';
      ctx.lineWidth = 1 / scale;
      const gridOffX = -tx / scale;
      const gridOffY = -ty / scale;
      const gridW = w / scale;
      const gridH = h / scale;
      for (let x = Math.floor(gridOffX / GRID_SIZE) * GRID_SIZE; x < gridOffX + gridW + GRID_SIZE; x += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(x, gridOffY); ctx.lineTo(x, gridOffY + gridH); ctx.stroke();
      }
      for (let y = Math.floor(gridOffY / GRID_SIZE) * GRID_SIZE; y < gridOffY + gridH + GRID_SIZE; y += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(gridOffX, y); ctx.lineTo(gridOffX + gridW, y); ctx.stroke();
      }

      // Center glow
      const cg = ctx.createRadialGradient(600, 350, 20 / scale, 600, 350, 350 / scale);
      cg.addColorStop(0, 'hsla(260, 50%, 30%, 0.08)');
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.fillRect(gridOffX, gridOffY, gridW, gridH);

      // Edges
      const now = Date.now();
      const edgeArr = Array.from(edges.values());
      const nodeArr = Array.from(nodes.values());

      for (const edge of edgeArr) {
        const age = now - edge.lastActiveAt;
        const alpha = Math.max(0, 1 - age / EDGE_FADE_MS);
        if (alpha <= 0.01) continue;

        const src = nodeArr.find((n) => n.id === edge.source);
        const tgt = nodeArr.find((n) => n.id === edge.target);
        if (!src || !tgt) continue;

        const sp = computeNodePos(src, nodeArr);
        const tp = computeNodePos(tgt, nodeArr);
        const sx = sp.x + sp.w / 2;
        const sy = sp.y + sp.h / 2;
        const tx2 = tp.x + tp.w / 2;
        const ty2 = tp.y + tp.h / 2;
        const cx = (sx + tx2) / 2;
        const cy = Math.min(sy, ty2) - 60;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cx, cy, tx2, ty2);

        ctx.shadowColor = edge.color;
        ctx.shadowBlur = 12;
        ctx.strokeStyle = edge.color.replace(')', `, ${alpha * 0.4})`).replace('hsl(', 'hsla(');
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.setLineDash([6 / scale, 8 / scale]);
        ctx.lineDashOffset = -now / 40;
        ctx.strokeStyle = edge.color.replace(')', `, ${alpha * 0.7})`).replace('hsl(', 'hsla(');
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.setLineDash([3 / scale, 12 / scale]);
        ctx.lineDashOffset = -now / 25;
        ctx.strokeStyle = edge.color.replace(')', `, ${alpha * 0.3})`).replace('hsl(', 'hsla(');
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        if (edge.label && age < 3000) {
          ctx.fillStyle = edge.color.replace(')', `, ${alpha * 0.8})`).replace('hsl(', 'hsla(');
          ctx.font = `${9 / scale}px "IBM Plex Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(edge.label.slice(0, 30), cx, cy - 12);
        }
      }

      ctx.restore();

      // Particles (screen-space)
      const particles = particlesRef.current;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]!;
        p.life--;
        if (p.life <= 0) {
          p.x = Math.random() * w; p.y = Math.random() * h;
          p.vx = (Math.random() - 0.5) * 0.3;
          p.vy = (Math.random() - 0.5) * 0.3 - 0.1;
          p.life = p.maxLife = 60 + Math.random() * 180;
          p.size = 1 + Math.random() * 2;
          continue;
        }
        p.x += p.vx * p.speed; p.y += p.vy * p.speed;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        const fadeIn = Math.min(1, p.life / 20);
        const fadeOut = Math.min(1, (p.maxLife - p.life) / 30);
        const a = fadeIn * fadeOut;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color; ctx.fill();
        ctx.shadowColor = p.color; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Burst particles (transformed)
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(scale, scale);
      for (const ev of events.slice(0, 3)) {
        const age = now - ev.timestamp;
        if (age > 2000) continue;
        const srcN = nodeArr.find((n) => n.id === ev.source);
        const tgtN = nodeArr.find((n) => n.id === ev.target);
        if (!srcN || !tgtN) continue;
        const sp2 = computeNodePos(srcN, nodeArr);
        const tp2 = computeNodePos(tgtN, nodeArr);
        const sx2 = sp2.x + sp2.w / 2;
        const sy2 = sp2.y + sp2.h / 2;
        const tx3 = tp2.x + tp2.w / 2;
        const ty3 = tp2.y + tp2.h / 2;
        const cx2 = (sx2 + tx3) / 2;
        const cy2 = Math.min(sy2, ty3) - 60;
        for (let b = 0; b < 4; b++) {
          const t = ((age / 2000) + b / 4) % 1;
          const bx = (1 - t) * (1 - t) * sx2 + 2 * (1 - t) * t * cx2 + t * t * tx3;
          const by = (1 - t) * (1 - t) * sy2 + 2 * (1 - t) * t * cy2 + t * t * ty3;
          ctx.beginPath(); ctx.arc(bx, by, 2 + (1 - t) * 3, 0, Math.PI * 2);
          ctx.fillStyle = (ev.color ?? 'hsl(280, 80%, 65%)').replace(')', `, ${Math.max(0, 1 - age / 2000) * (1 - t) * 0.8})`).replace('hsl(', 'hsla(');
          ctx.fill();
        }
      }
      ctx.restore();

      animFrameRef.current = requestAnimationFrame(frame);
    };
    animFrameRef.current = requestAnimationFrame(frame);
    return () => { running = false; cancelAnimationFrame(animFrameRef.current); };
  }, [dim, events, edges, nodes, paused, transform]);

  // ── Decay ──
  useEffect(() => { const t = setInterval(() => decayActivity(), 500); return () => clearInterval(t); }, [decayActivity]);

  // ── Prune stale fleet nodes ──
  useEffect(() => {
    const t = setInterval(() => useVizStore.getState().prunesStale(NODE_LINGER_MS), 10_000);
    return () => clearInterval(t);
  }, []);

  // ── Fleet node filtering for render ──
  const sessionNodes = useMemo(
    () => Array.from(nodes.values()).filter((n) => n.kind === 'session' && n.id.startsWith('fleet:')),
    [nodes],
  );
  const agentNodes = useMemo(
    () => Array.from(nodes.values()).filter((n) => n.kind === 'agent' && n.id.startsWith('fleet:agent:')),
    [nodes],
  );
  const activeAgentCount = useMemo(
    () => agentNodes.filter((n) => n.status === 'active').length,
    [agentNodes],
  );
  const totalCost = useMemo(
    () => agentNodes.reduce((s, n) => s + (n.costUsd ?? 0), 0),
    [agentNodes],
  );
  const totalIterations = useMemo(
    () => agentNodes.reduce((s, n) => s + (n.iterations ?? 0), 0),
    [agentNodes],
  );

  // ── Render ──
  return (
    <div
      ref={containerRef}
      className={cn('relative w-full h-full overflow-hidden', className)}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      style={{ cursor: isPanning.current ? 'grabbing' : 'grab' }}
    >
      {/* Canvas layer */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {/* Fleet nodes (DOM layer, transformed) */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {sessionNodes.map((sn) => (
          <FleetSessionNode
            key={sn.id}
            node={sn}
            sessions={sessionNodes}
            agents={agentNodes}
            onClick={() => setSelectedEvent({ ...sn, kind: 'session:start', source: sn.id, target: '', label: sn.label, magnitude: 0, timestamp: Date.now() } as unknown as VizEvent)}
          />
        ))}
        {agentNodes.map((an) => (
          <FleetAgentNode
            key={an.id}
            node={an}
            sessions={sessionNodes}
            agents={agentNodes}
            onClick={() => setSelectedEvent({ ...an, kind: 'agent:spawned', source: an.id, target: an.sessionId ?? '', label: an.label, magnitude: 0, timestamp: Date.now() } as unknown as VizEvent)}
          />
        ))}
      </div>

      {/* HUD — top-left stats */}
      <div className="absolute top-4 left-4 flex gap-6 pointer-events-none z-10">
        <HudStat label="Nodes" value={String(nodes.size)} color="hsl(280,80%,65%)" />
        <HudStat label="Active" value={String(activeAgentCount)} color="hsl(40,90%,55%)" />
        <HudStat label="Sessions" value={String(sessionNodes.length)} color="hsl(220,80%,60%)" />
        <HudStat label="Events" value={String(counters?.totalToolCalls ?? 0)} color="hsl(180,80%,55%)" />
        <HudStat label="Cost" value={`${totalCost.toFixed(3)}`} color="hsl(140,70%,55%)" />
        <HudStat label="Iter" value={String(totalIterations)} color="hsl(0,0%,60%)" />
      </div>

      {/* HUD — zoom level top-left below stats */}
      <div className="absolute top-28 left-4 pointer-events-none z-10 text-[9px] font-mono text-white/20">
        {Math.round(transform.scale * 100)}%
      </div>

      {/* Controls */}
      <div className="absolute bottom-4 left-4 flex gap-2 z-10">
        <button
          className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-white/50 hover:text-white hover:border-white/30 transition-colors bg-black/40 backdrop-blur-sm"
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button
          className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-white/50 hover:text-white hover:border-white/30 transition-colors bg-black/40 backdrop-blur-sm"
          onClick={resetZoom}
        >
          ⊞ Reset
        </button>
        <button
          className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-white/50 hover:text-white hover:border-white/30 transition-colors bg-black/40 backdrop-blur-sm"
          onClick={() => useVizStore.getState().clear()}
        >
          ✕ Clear
        </button>
      </div>

      {/* Zoom hint */}
      <div className="absolute bottom-4 right-4 z-10 text-[9px] font-mono text-white/10 pointer-events-none select-none text-right leading-relaxed">
        Wheel · zoom<br />
        Ctrl+drag · pan
      </div>

      {/* Event detail modal */}
      {selectedEvent && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setSelectedEvent(null)}>
          <div className="bg-[#0d0a1a] border border-white/10 rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white/80">{selectedEvent.label}</h3>
              <button className="text-white/30 hover:text-white/60 text-lg leading-none" onClick={() => setSelectedEvent(null)}>✕</button>
            </div>
            <pre className="text-[10px] font-mono text-white/50 overflow-auto max-h-64 whitespace-pre-wrap break-all">
              {JSON.stringify(selectedEvent, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}