import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp } from 'lucide-react';
import { memo, useMemo, useState } from 'react';

/** When a tool dumps hundreds of lines of output, the chat turns into a
 *  scroll-wall. This threshold gates the auto-collapse: anything longer
 *  shows the first ~LONG_PEEK_LINES with a "Show all N more" toggle. */
const LONG_OUTPUT_THRESHOLD = 25;
const LONG_PEEK_LINES = 12;

/**
 * Render `text` as a monospace block, auto-collapsing when it exceeds
 * LONG_OUTPUT_THRESHOLD lines. The first LONG_PEEK_LINES stay visible;
 * the rest expand on click. Keeping the wrap class configurable lets the
 * `numbered` path use `whitespace-pre` (no wrap) and the bash/plain path
 * use `whitespace-pre-wrap break-all` (wrap and break long URLs/paths).
 */
function CollapsibleText({
  text,
  isError,
  className,
  wrapClass,
  showLineNumbers,
}: {
  text: string;
  isError?: boolean;
  className?: string;
  wrapClass: string;
  /** Whether to render a left gutter with line numbers when the output is
   *  long. Off for the numbered/Read-tool path (which already prefixes its
   *  own line numbers in the content) and for wrap-mode bodies where a
   *  fixed gutter can't stay aligned with wrapped lines. */
  showLineNumbers?: boolean;
}) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const isLong = lines.length > LONG_OUTPUT_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  const shown = expanded ? text : lines.slice(0, LONG_PEEK_LINES).join('\n');
  // Only emit the gutter when the body won't wrap (alignment would break
  // otherwise) AND the user actually expanded it / it's not super short.
  const renderGutter = !!showLineNumbers && isLong && expanded;
  return (
    <div className={cn('rounded-md border bg-background/40 overflow-hidden', className)}>
      {renderGutter ? (
        // Force `whitespace-pre` inside the gutter view so the line numbers
        // stay 1:1 with content rows. Long horizontal lines scroll within
        // the shared overflow container rather than wrapping (which would
        // break alignment between the gutter and the body).
        <div className="flex max-h-96 overflow-auto">
          <pre
            aria-hidden
            className="text-xs font-mono leading-[1.4] py-2 pl-2 pr-2 text-muted-foreground/50 select-none border-r border-border/40 bg-muted/20 tabular-nums text-right whitespace-pre shrink-0"
          >
            {lines.map((_, i) => `${i + 1}`).join('\n')}
          </pre>
          <pre
            className={cn(
              'text-xs font-mono leading-[1.4] py-2 px-2 flex-1 whitespace-pre',
              isError ? 'text-destructive' : 'text-foreground',
            )}
          >
            {shown}
          </pre>
        </div>
      ) : (
        <pre
          className={cn(
            'text-xs font-mono p-2 max-h-96 overflow-auto',
            wrapClass,
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {shown}
        </pre>
      )}
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 border-t bg-muted/30 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronsUp className="h-3 w-3" />
              Collapse to first {LONG_PEEK_LINES} lines
            </>
          ) : (
            <>
              <ChevronsDown className="h-3 w-3" />
              Show all {lines.length} lines ({lines.length - LONG_PEEK_LINES} more)
            </>
          )}
        </button>
      )}
    </div>
  );
}

interface Props {
  toolName?: string;
  result: string;
  isError?: boolean;
  className?: string;
}

/**
 * Decides which renderer to use for a tool result based on its shape /
 * tool name. The goal is to make output *legible at a glance*:
 *   - Read tool with leading line numbers stays line-numbered, monospace.
 *   - Bash output gets a "exit code N" footer split from stdout.
 *   - Valid JSON gets pretty-printed and collapsible by default.
 *   - Everything else falls back to raw monospace.
 */
export const ToolResult = memo(function ToolResult({
  toolName,
  result,
  isError,
  className,
}: Props) {
  const shape = useMemo(() => detectShape(toolName, result), [toolName, result]);

  if (shape.kind === 'json') {
    return <JsonResult value={shape.value} isError={isError} className={className} />;
  }
  if (shape.kind === 'numbered') {
    return (
      <CollapsibleText
        text={result}
        isError={isError}
        className={className}
        wrapClass="whitespace-pre"
      />
    );
  }
  if (shape.kind === 'bash') {
    return (
      <div className={cn('rounded-md border bg-background/40 overflow-hidden', className)}>
        {shape.stdout && (
          <CollapsibleText
            text={shape.stdout}
            isError={isError}
            // Nested CollapsibleText already adds border/bg; strip them here
            // so we get one outer frame, not two.
            className="border-0 rounded-none bg-transparent"
            wrapClass="whitespace-pre-wrap break-all"
            showLineNumbers
          />
        )}
        {(shape.exitCode !== undefined || shape.duration) && (
          <div
            className={cn(
              'flex items-center gap-3 text-[11px] px-2 py-1 border-t bg-muted/30 tabular-nums',
              shape.exitCode && shape.exitCode !== 0 ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {shape.exitCode !== undefined && (
              <span>
                exit code: <span className="font-mono">{shape.exitCode}</span>
              </span>
            )}
            {shape.duration && <span>{shape.duration}</span>}
          </div>
        )}
      </div>
    );
  }
  return (
    <CollapsibleText
      text={result}
      isError={isError}
      className={className}
      wrapClass="whitespace-pre-wrap break-all"
      showLineNumbers
    />
  );
});

interface Shape {
  kind: 'numbered' | 'json' | 'bash' | 'plain';
  /** For JSON results. */
  value?: unknown;
  /** For bash-shape results. */
  stdout?: string;
  exitCode?: number;
  duration?: string;
}

function detectShape(toolName: string | undefined, result: string): Shape {
  const trimmed = result.trim();
  // ---- Read tool: lines like "  42→ const foo = …" -------------
  if (/^\s*\d+→/m.test(result.slice(0, 200))) {
    return { kind: 'numbered' };
  }
  // ---- JSON ---------------------------------------------------------
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return { kind: 'json', value: parsed };
      }
    } catch {
      /* fall through */
    }
  }
  // ---- Bash-ish -----------------------------------------------------
  const isBashTool = !!toolName && /^(bash|shell|exec|run)/i.test(toolName);
  // Many bash wrappers emit a trailing "exit code: N" or "[exit 1]" line.
  const exitMatch = result.match(/(?:^|\n)\s*(?:\[?exit(?:\s*code)?\]?\s*[:=]?\s*)(\d+)\s*$/i);
  const durMatch = result.match(/(?:^|\s)(\d+\s*ms|\d+\.\d+s)\s*$/i);
  if (isBashTool || exitMatch) {
    let stdout = result;
    if (exitMatch) stdout = result.slice(0, exitMatch.index).trimEnd();
    return {
      kind: 'bash',
      stdout,
      exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
      duration: durMatch?.[1],
    };
  }
  return { kind: 'plain' };
}

function JsonResult({
  value,
  isError,
  className,
}: {
  value: unknown;
  isError?: boolean;
  className?: string;
}) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const lineCount = pretty.split('\n').length;
  const [expanded, setExpanded] = useState(lineCount < 30);
  return (
    <div
      className={cn(
        'rounded-md border bg-background/40 overflow-hidden',
        isError && 'border-destructive/40',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-2 py-1 border-b bg-muted/30 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-mono">JSON · {lineCount} lines</span>
        </span>
        <span>{expanded ? 'collapse' : 'expand'}</span>
      </button>
      {expanded && (
        <pre
          className={cn(
            'text-xs font-mono whitespace-pre p-2 max-h-96 overflow-auto',
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}
