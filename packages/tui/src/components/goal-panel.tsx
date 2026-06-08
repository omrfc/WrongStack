import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../theme.js';
import type { GoalSummary } from '../app-state.js';

export interface GoalPanelProps {
  goal: GoalSummary;
}

/**
 * Full-screen overlay showing the current goal, deliverables checklist,
 * and progress bar. Opened with F9.
 */
export function GoalPanel({ goal }: GoalPanelProps): React.ReactElement {
  if (!goal) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color={theme.accent}>🎯 Goal</Text>
        </Box>
        <Box>
          <Text dimColor>No goal set. Use </Text>
          <Text color={theme.accent}>/goal set {"<mission>"}</Text>
          <Text dimColor> to create one.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press F9 or Esc to close.</Text>
        </Box>
      </Box>
    );
  }

  const displayGoal = goal.refinedGoal || goal.goal;
  const stateIcon =
    goal.goalState === 'active' ? '🔄'
    : goal.goalState === 'paused' ? '⏸'
    : goal.goalState === 'completed' ? '✅'
    : '⏹';

  const stateColor =
    goal.goalState === 'active' ? 'green'
    : goal.goalState === 'paused' ? 'yellow'
    : goal.goalState === 'completed' ? 'green'
    : 'red';

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>🎯 Goal — {goal.goalState}</Text>
      </Box>

      {/* Goal text */}
      <Box marginBottom={1}>
        <Text>{stateIcon} </Text>
        <Text bold>{displayGoal}</Text>
      </Box>

      {/* Original if refined */}
      {goal.refinedGoal && goal.refinedGoal !== goal.goal && (
        <Box marginBottom={1}>
          <Text dimColor>  (original: {goal.goal.length > 60 ? goal.goal.slice(0, 57) + '…' : goal.goal})</Text>
        </Box>
      )}

      {/* Progress bar */}
      {typeof goal.progress === 'number' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            {renderProgressBar(goal.progress, goal.progressTrend)}
          </Box>
          {goal.progressNote && (
            <Box>
              <Text dimColor>  {goal.progressNote}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Deliverables checklist */}
      {goal.deliverables && goal.deliverables.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold>Deliverables ({goal.deliverables.length}):</Text>
          </Box>
          {goal.deliverables.map((d, i) => {
            const done = /^\[[x✓]\]|✅|\(done\)/i.test(d);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: deliverables are stable text strings
              <Box key={i}>
                <Text color={done ? 'green' : undefined} dimColor={!done}>
                  {'  '}{done ? '✓' : '○'} {d}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Stats */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text dimColor>Iterations: </Text>
          <Text>{goal.iterations}</Text>
        </Box>
        <Box>
          <Text dimColor>State: </Text>
          <Text color={stateColor}>{stateIcon} {goal.goalState}</Text>
        </Box>
        {goal.lastTask && (
          <Box>
            <Text dimColor>Last task: </Text>
            <Text>{goal.lastTask.length > 50 ? goal.lastTask.slice(0, 47) + '…' : goal.lastTask}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Press F9 or Esc to close.</Text>
        </Box>
      </Box>
    </Box>
  );
}

function renderProgressBar(progress: number, trend?: string): React.ReactElement {
  const pct = Math.min(100, Math.max(0, Math.round(progress)));
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;

  const trendIcon =
    trend === 'accelerating' ? ' 🚀'
    : trend === 'stalling' ? ' ⚠️'
    : trend === 'steady' ? ' ➡️'
    : '';

  return (
    <Box>
      <Text bold>Progress: </Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text bold> {pct}%</Text>
      {trend && <Text dimColor>{trendIcon} {trend}</Text>}
    </Box>
  );
}
