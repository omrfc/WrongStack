/**
 * CoordinatorPanel — AutonomousCoordinator live view.
 *
 * Shows project-level coordination activity across all sessions:
 * - Active goals with progress
 * - Task dependency DAG status
 * - Shared knowledge facts
 * - Consensus decisions
 *
 * Rendered as an overlay when the coordinator monitor is open (Ctrl+Shift+C).
 */
import { Box, Text, useInput } from '../ink.js';
import { useCallback } from 'react';
import type React from 'react';
import type { State } from '../app.js';

export interface CoordinatorPanelProps {
  coordinator: State['coordinator'];
  /** 1s clock tick so elapsed times stay live. */
  nowTick: number;
  /** Called when the user presses Esc or q to close the panel. */
  onClose: () => void;
}

const KIND_COLOR: Record<string, string> = {
  goal: 'cyan',
  task: 'yellow',
  knowledge: 'green',
  consensus: 'magenta',
  deadlock: 'red',
};

function fmtElapsed(at: number, nowTick: number): string {
  const s = Math.floor((nowTick - at) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function GoalRow({
  goal,
}: {
  goal: State['coordinator']['goals'][0];
}): React.ReactElement {
  const statusColor: Record<string, string> = {
    active: 'green',
    paused: 'yellow',
    completed: 'gray',
    failed: 'red',
  };
  const color = statusColor[goal.status] ?? 'gray';
  return (
    <Box key={goal.id} flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {goal.status === 'active' ? '▶' : goal.status === 'paused' ? '⏸' : goal.status === 'completed' ? '✓' : '✗'}{' '}
          {goal.title || '(unnamed goal)'}
        </Text>
      </Box>
      {goal.tasks.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {goal.tasks.map((task) => {
            const taskColor: Record<string, string> = {
              pending: 'gray',
              running: 'yellow',
              done: 'green',
              failed: 'red',
            };
            return (
              <Box key={task.id}>
                <Text color={taskColor[task.status] ?? 'gray'}>
                  {task.status === 'pending' ? '○' : task.status === 'running' ? '▶' : task.status === 'done' ? '✓' : '✗'}{' '}
                  {task.title}
                  {task.assignedTo ? <Text dimColor> → {task.assignedTo}</Text> : null}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      {goal.participants.length > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            participants: {goal.participants.join(', ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function CoordinatorPanel({
  coordinator,
  nowTick,
  onClose,
}: CoordinatorPanelProps): React.ReactElement {
  const handleInput = useCallback(
    (input: string, _key: { escape?: boolean }) => {
      if (input === 'q' || input === 'Q' || input === '\x1b') {
        onClose();
      }
    },
    [onClose],
  );

  useInput(handleInput);

  const { goals, timeline, knowledgeCount, healthy } = coordinator;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={Math.min(30, Math.max(10, goals.length * 4 + timeline.length + 8))}
      width={80}
    >
      {/* Header */}
      <Box borderStyle="bold" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">🤖 AutonomousCoordinator</Text>
        <Box flexGrow={1} />
        <Text dimColor={!healthy} color={healthy ? 'green' : 'red'}>
          {healthy ? '● connected' : '○ disconnected'}
        </Text>
        <Text dimColor> · q/esc to close</Text>
      </Box>

      {/* Goals section */}
      {goals.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Goals ({goals.length})</Text>
          {goals.map((goal) => (
            <GoalRow key={goal.id} goal={goal} />
          ))}
        </Box>
      )}

      {/* Knowledge section */}
      <Box marginBottom={1}>
        <Text bold>Knowledge </Text>
        <Text color="green">{knowledgeCount}</Text>
        <Text dimColor> shared facts</Text>
      </Box>

      {/* Timeline section */}
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>Activity</Text>
        {timeline.length === 0 ? (
          <Text dimColor>  No activity yet</Text>
        ) : (
          timeline.slice(0, 10).map((entry, i) => (
            <Box key={i} alignItems="flex-start">
              <Text color={KIND_COLOR[entry.kind] ?? 'gray'} dimColor={i > 2}>
                {entry.icon}
              </Text>
              <Box flexGrow={1} marginLeft={1}>
                <Text dimColor={i > 2}>{entry.text}</Text>
              </Box>
              <Box marginLeft={1}>
                <Text dimColor>{fmtElapsed(entry.at, nowTick)}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
