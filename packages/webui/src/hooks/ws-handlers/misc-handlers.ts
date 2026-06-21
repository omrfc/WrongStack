import { normalizedEqual } from '@wrongstack/core';
import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import type { PhaseItem } from '@/components/PhasePanel';
import { useAutoPhaseStore, useChatStore, useFileStore, useGitChangesStore, useGitInfoStore, useGoalStore, useSessionStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

export function handleAutoPhaseState(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  useAutoPhaseStore.getState().setState({
    phases: Array.isArray(p.phases) ? (p.phases as PhaseItem[]) : undefined,
    activePhaseId: typeof p.activePhaseId === 'string' ? p.activePhaseId : undefined,
    overallPercent: typeof p.overallPercent === 'number' ? p.overallPercent : undefined,
    autonomous: typeof p.autonomous === 'boolean' ? p.autonomous : undefined,
    title: typeof p.title === 'string' ? p.title : undefined,
  });
}

export function handleGoalUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown> | null;
  useGoalStore.getState().setGoal(p);
}

export function handlePrefsUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  (useLocalPrefs.getState().set as (patch: Record<string, unknown>) => void)(p);
}

export function handleBrainStatus(msg: WSServerMessage) {
  const p = msg.payload as {
    maxAutoRisk: string;
    log: Array<{ at: number; kind: string; question: string; outcome: string }>;
  };
  const lines = [
    '🧠 **Brain** — policy → LLM decision chain',
    '',
    `Autonomy ceiling: \`${p.maxAutoRisk}\` _(change with \`/brain risk <off|low|medium|high|all>\`)_`,
  ];
  if (p.log.length === 0) {
    lines.push('', '_No decisions recorded yet this session._');
  } else {
    lines.push('', `Recent decisions (${p.log.length}):`);
    for (const entry of p.log.slice(-10)) {
      const ago = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
      const age = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`;
      const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
      lines.push(`- \`${age} ago\` **${entry.kind}** — ${q}${entry.outcome ? ` → _${entry.outcome}_` : ''}`);
    }
  }
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleBrainAnswer(msg: WSServerMessage) {
  const p = msg.payload as {
    question: string;
    decision: { type: string; text?: string; rationale?: string; reason?: string };
  };
  let content: string;
  if (p.decision.type === 'answer') {
    const rationale =
      p.decision.rationale && p.decision.rationale !== p.decision.text
        ? `\n\n_${p.decision.rationale}_`
        : '';
    content = `🧠 ${p.decision.text ?? ''}${rationale}`;
  } else if (p.decision.type === 'deny') {
    content = `🧠 Denied: ${p.decision.reason ?? ''}`;
  } else {
    content = '🧠 The Brain escalated this question back to you — it needs human judgement.';
  }
  useChatStore.getState().addMessage({ role: 'assistant', content });
}

export function handleBrainEvent(msg: WSServerMessage) {
  const p = msg.payload as {
    event: string;
    intervened?: boolean;
    request?: { question?: string; source?: string; risk?: string };
    decision?: { type?: string; optionId?: string; text?: string; reason?: string; rationale?: string };
  };
  if (p.event === 'brain.intervention') {
    const guidance = p.decision?.rationale ?? p.decision?.text ?? '';
    const headline = p.intervened
      ? '🧠 **Brain intervention** — corrective guidance was sent to the agent.'
      : '🧠 **Brain check** — a distress signal was reviewed; no action needed.';
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: [headline, p.request?.question ?? '', guidance ? `_${guidance}_` : '']
        .filter(Boolean)
        .join('\n\n'),
    });
    if (p.intervened) toast.info('Brain intervened: agent steered');
  } else if (p.event === 'brain.decision_denied') {
    toast.warn(`Brain denied: ${p.decision?.reason ?? p.request?.question ?? 'request'}`);
  }
}

export function handleWorkingDirChanged(msg: WSServerMessage) {
  const p = msg.payload as { cwd: string; projectRoot: string };
  useSessionStore.getState().setEnv({
    cwd: p.cwd,
    projectRoot: p.projectRoot,
    projectName: p.projectRoot.split(/[/\\]/).pop() || p.projectRoot,
  });
  useFileStore.getState().setTreeLoading(true);
  getWSClient().send({ type: 'files.tree', payload: { path: p.cwd } });
}

export function handleModelRefineResult(msg: WSServerMessage) {
  const p = msg.payload as { refined: string; english: string; error?: string | undefined };
  const refinePanel = useUIStore.getState().refinePanel;
  if (!refinePanel) return;
  if (p.error) {
    toast.error(`Refinement failed: ${p.error}`);
    const { original } = refinePanel;
    useUIStore.getState().setRefinePanel(null);
    useChatStore.getState().addMessage({ role: 'user', content: original });
    useChatStore.getState().setLoading(true);
    getWSClient().send({ type: 'user_message', payload: { id: `msg_${Date.now()}`, content: original, timestamp: Date.now() } });
    return;
  }
  const original = refinePanel.original;
  if (normalizedEqual(p.refined, original)) {
    useUIStore.getState().setRefinePanel(null);
    useChatStore.getState().addMessage({ role: 'user', content: original });
    useChatStore.getState().setLoading(true);
    getWSClient().send({ type: 'user_message', payload: { id: `msg_${Date.now()}`, content: original, timestamp: Date.now() } });
    return;
  }
  useUIStore.getState().setRefinePanel({
    ...refinePanel,
    refined: p.refined,
    english: p.english,
  });
}

export function handleGitInfo(msg: WSServerMessage) {
  const p = msg.payload as { branch: string; added: number; deleted: number; untracked: number; behind: number; ahead: number };
  useGitInfoStore.getState().setInfo({ ...p, fetchedAt: Date.now() });
}

export function handleGitChanges(msg: WSServerMessage) {
  const p = msg.payload as {
    files: Array<{ path: string; status: string; added: number; deleted: number; staged: boolean }>;
    error?: string | undefined;
  };
  useGitChangesStore.getState().setFiles(p.files ?? [], p.error ?? null);
}

export function handleGitDiff(msg: WSServerMessage) {
  const p = msg.payload as {
    path: string;
    oldText?: string | undefined;
    newText?: string | undefined;
    binary?: boolean | undefined;
    tooLarge?: boolean | undefined;
    error?: string | undefined;
  };
  if (useGitChangesStore.getState().selectedPath !== p.path) return;
  useGitChangesStore.getState().setDiff({
    path: p.path,
    oldText: p.oldText ?? '',
    newText: p.newText ?? '',
    binary: p.binary,
    tooLarge: p.tooLarge,
    error: p.error,
  });
}

export const miscHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'goal.updated': handleGoalUpdated,
  'prefs.updated': handlePrefsUpdated,
  'autophase.state': handleAutoPhaseState,
  'brain.status': handleBrainStatus,
  'brain.answer': handleBrainAnswer,
  'brain.event': handleBrainEvent,
  'working_dir.changed': handleWorkingDirChanged,
  'model.refine_result': handleModelRefineResult,
  'git.info': handleGitInfo,
  'git.changes': handleGitChanges,
  'git.diff': handleGitDiff,
};
