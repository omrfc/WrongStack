/**
 * WatchMessageBubble — renders a session watch entry with the same visual
 * style as the main ChatView MessageBubble.
 *
 * Mirrors the ChatView bubble aesthetic:
 * - Avatar circle with role-specific icon
 * - Rounded bubble with role-specific background
 * - Full markdown rendering (ReactMarkdown + remarkGfm)
 * - Error styling for error-role entries
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Bot, Terminal, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CopyButton } from './MessageBubble/CopyButton.js';
import { ToolInputView } from './MessageBubble/ToolInputView.js';
import { ErrorBodyWithStack } from './MessageBubble/ErrorBody.js';
import { markdownComponents, rehypePlugins } from './MessageBubble/utils.js';

interface WatchEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
  tool?: string;
}

interface WatchMessageBubbleProps {
  entry: WatchEntry;
  isContinuation?: boolean;
}

const ROLE_CONFIG: Record<
  WatchEntry['role'],
  {
    Icon: typeof User;
    label: string;
    avatarBg: string;
    avatarColor: string;
    avatarRing: string;
    bubbleBg: string;
    bubbleBorder: string;
    textColor: string;
  }
> = {
  user: {
    Icon: User,
    label: 'You',
    avatarBg: 'bg-primary',
    avatarColor: 'text-primary-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-primary/20',
    bubbleBg: 'bg-primary',
    bubbleBorder: 'border-transparent',
    textColor: 'text-primary-foreground',
  },
  assistant: {
    Icon: Bot,
    label: 'Assistant',
    avatarBg: 'bg-accent',
    avatarColor: 'text-accent-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-accent/20',
    bubbleBg: 'bg-card',
    bubbleBorder: 'border-border',
    textColor: 'text-foreground',
  },
  tool: {
    Icon: Terminal,
    label: 'Tool',
    avatarBg: 'bg-secondary',
    avatarColor: 'text-secondary-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-secondary/20',
    bubbleBg: 'bg-muted/80',
    bubbleBorder: 'border-border',
    textColor: 'text-foreground',
  },
  system: {
    Icon: Bot,
    label: 'System',
    avatarBg: 'bg-muted',
    avatarColor: 'text-muted-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-muted/20',
    bubbleBg: 'bg-muted/50',
    bubbleBorder: 'border-border',
    textColor: 'text-muted-foreground',
  },
  error: {
    Icon: AlertCircle,
    label: 'Error',
    avatarBg: 'bg-destructive',
    avatarColor: 'text-destructive-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-destructive/20',
    bubbleBg: 'bg-destructive/5',
    bubbleBorder: 'border-destructive/20',
    textColor: 'text-destructive',
  },
};

function WatchBubbleContent({ entry }: { entry: WatchEntry }) {
  if (!entry.text) return null;

  if (entry.role === 'error') {
    return <ErrorBodyWithStack text={entry.text} />;
  }

  if (entry.role === 'tool') {
    // Try to parse tool input from text (format: "toolName\n{json}")
    const lines = entry.text.split('\n');
    let toolName = entry.tool || 'tool';
    let inputText: string | null = null;

    // If text contains a JSON object, try to parse it
    if (lines.length > 1) {
      const maybeJson = lines.slice(1).join('\n');
      try {
        JSON.parse(maybeJson);
        toolName = lines[0] || entry.tool || 'tool';
        inputText = maybeJson;
      } catch {
        // Not JSON, render as plain text
      }
    }

    return (
      <div className="flex flex-col gap-1.5 tool-details">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Terminal className="h-3 w-3" />
          <span className="font-mono">{toolName}</span>
        </div>
        {inputText ? (
          <div className="p-3 bg-muted/50 rounded-lg overflow-x-auto">
            <ToolInputView input={JSON.parse(inputText)} />
          </div>
        ) : (
          <div className="text-sm leading-relaxed markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={markdownComponents}>{entry.text}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm leading-relaxed markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {entry.text}
      </ReactMarkdown>
    </div>
  );
}

export function WatchMessageBubble({
  entry,
  isContinuation = false,
}: WatchMessageBubbleProps) {
  const cfg = ROLE_CONFIG[entry.role];
  const Icon = cfg.Icon;

  return (
    <div className="group flex gap-3 animate-message msg-bubble rounded-lg transition-shadow">
      {/* Avatar — blank spacer for continuation, matching ChatView continuation pattern */}
      {isContinuation ? (
        <div className="flex-shrink-0 w-8" />
      ) : (
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            cfg.avatarBg,
            cfg.avatarColor,
            cfg.avatarRing,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      )}

      {/* Content */}
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        {/* Role label + timestamp — only shown on first message of a chain */}
        {!isContinuation && (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-xs font-medium',
                cfg.textColor,
              )}
            >
              {entry.role === 'tool' && entry.tool ? entry.tool : cfg.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(entry.ts).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        )}

        {/* Bubble */}
        <div
          className={cn(
            'rounded-2xl px-4 py-3 border',
            entry.role === 'user' && 'rounded-br-md',
            entry.role === 'assistant' && 'rounded-bl-md',
            entry.role === 'tool' && 'rounded-bl-sm',
            entry.role === 'system' && 'rounded-bl-sm opacity-70',
            entry.role === 'error' && 'rounded-bl-sm',
            cfg.bubbleBg,
            cfg.bubbleBorder,
          )}
        >
          <div
            className={cn(
              'text-sm leading-relaxed markdown-content',
              cfg.textColor,
            )}
          >
            <WatchBubbleContent entry={entry} />
          </div>
        </div>

        {/* Copy button — group-hover for hover visibility, matching ChatView */}
        {entry.text && entry.role !== 'error' && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={entry.text} label="Copy" />
          </div>
        )}
      </div>
    </div>
  );
}
