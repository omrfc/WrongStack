import { describe, expect, it } from 'vitest';
import { createHqEventEnvelope } from '../../src/hq/protocol.js';
import {
  redactHqEvent,
  redactHqValue,
  scrubAndTruncateHqPreview,
  summarizeHqToolArgs,
} from '../../src/hq/redaction.js';

describe('HQ redaction', () => {
  it('drops raw prompt/tool/file content by default', () => {
    const result = redactHqValue({
      prompt: 'implement a secret feature',
      fileContent: 'const value = 1;',
      nested: { stdout: 'very long raw command output' },
      safeSummary: 'tool completed',
    });

    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      prompt: '[REDACTED:hq_raw_content]',
      fileContent: '[REDACTED:hq_raw_content]',
      nested: { stdout: '[REDACTED:hq_raw_content]' },
      safeSummary: 'tool completed',
    });
  });

  it('redacts sensitive fields regardless of raw content policy', () => {
    const result = redactHqValue(
      {
        token: 'plain-token-value',
        headers: {
          Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        },
        rawContent: 'allowed raw text',
      },
      { policy: { rawContent: true } },
    );

    expect(result.value).toEqual({
      token: '[REDACTED:hq_sensitive_field]',
      headers: {
        Authorization: '[REDACTED:hq_sensitive_field]',
      },
      rawContent: 'allowed raw text',
    });
  });

  it('scrubs secrets that appear in non-sensitive strings', () => {
    const result = redactHqValue({
      summary: 'using Bearer abcdefghijklmnopqrstuvwxyz for auth',
    });

    expect(result.value.summary).toContain('[REDACTED:bearer_token]');
  });

  it('converts project-local paths to project-relative paths', () => {
    const result = redactHqValue(
      {
        projectRoot: 'D:\\Codebox\\PROJECTS\\WrongStack',
        filePath: 'D:\\Codebox\\PROJECTS\\WrongStack\\packages\\core\\src\\hq\\protocol.ts',
      },
      { projectRoot: 'D:/Codebox/PROJECTS/WrongStack' },
    );

    expect(result.value).toEqual({
      projectRoot: '.',
      filePath: 'packages/core/src/hq/protocol.ts',
    });
  });

  it('redacts all paths when path policy is redacted', () => {
    const result = redactHqValue(
      { cwd: '/home/user/project', file: '/home/user/project/src/index.ts' },
      { policy: { paths: 'redacted' }, projectRoot: '/home/user/project' },
    );

    expect(result.value).toEqual({
      cwd: '[REDACTED:hq_path]',
      file: '[REDACTED:hq_path]',
    });
  });

  it('redacts event payloads while preserving envelope metadata', () => {
    const event = createHqEventEnvelope({
      id: 'evt_1',
      type: 'tool.completed',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      sessionId: 'session_1',
      seq: 7,
      payload: {
        toolName: 'bash',
        output: 'SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
      },
    });

    const result = redactHqEvent(event);

    expect(result.value.id).toBe('evt_1');
    expect(result.value.sessionId).toBe('session_1');
    expect(result.value.payload).toEqual({
      toolName: 'bash',
      output: '[REDACTED:hq_raw_content]',
    });
  });

  it('redacts mailbox bodies while keeping scrubbed previews useful', () => {
    const result = redactHqValue(
      {
        message: {
          subject: 'Please review auth flow',
          body: 'The raw mailbox body should not be shipped to HQ by default.',
          bodyPreview: 'Use Bearer abcdefghijklmnopqrstuvwxyz for the repro',
          outcomePreview: 'Fixed in session_1',
        },
      },
      { maxSummaryLength: 80 },
    );

    expect(result.value).toEqual({
      message: {
        subject: 'Please review auth flow',
        body: '[REDACTED:hq_raw_content]',
        bodyPreview: 'Use[REDACTED:bearer_token]for the repro',
        outcomePreview: 'Fixed in session_1',
      },
    });
  });

  it('summarizes tool args without exposing nested objects or sensitive values', () => {
    const summary = summarizeHqToolArgs(
      {
        command: 'pnpm test -- --runInBand',
        token: 'secret',
        args: ['--filter', 'core'],
        nested: { raw: 'value' },
      },
      { policy: { toolArgs: 'summary' } },
    );

    expect(summary).toEqual({
      command: 'pnpm test -- --runInBand',
      token: '[REDACTED:hq_sensitive_field]',
      args: '[array:2]',
      nested: '[object]',
    });
  });

  it('can hide tool args entirely', () => {
    expect(summarizeHqToolArgs({ command: 'secret' }, { policy: { toolArgs: 'none' } })).toBe(
      '[REDACTED:hq_tool_args]',
    );
  });
});

describe('scrubAndTruncateHqPreview', () => {
  it('returns undefined for non-string or empty input', () => {
    expect(scrubAndTruncateHqPreview(undefined)).toBeUndefined();
    expect(scrubAndTruncateHqPreview(null)).toBeUndefined();
    expect(scrubAndTruncateHqPreview(42)).toBeUndefined();
    expect(scrubAndTruncateHqPreview('')).toBeUndefined();
  });

  it('returns the string unchanged when shorter than the max length', () => {
    expect(scrubAndTruncateHqPreview('hello world', 280)).toBe('hello world');
  });

  it('truncates strings longer than the max length and reports dropped chars', () => {
    const long = 'a'.repeat(500);
    const result = scrubAndTruncateHqPreview(long, 50);
    expect(result).not.toBeUndefined();
    expect(result!.startsWith('a'.repeat(50))).toBe(true);
    expect(result).toContain('[truncated:450]');
  });

  it('scrubs embedded secrets before returning the preview', () => {
    // 40-char GitHub-style PAT — DefaultSecretScrubber catches `ghp_` + 36 alnum.
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = scrubAndTruncateHqPreview(`attached ${secret} please review`, 280);
    expect(result).not.toBeUndefined();
    expect(result!.toLowerCase()).not.toContain(secret.toLowerCase());
  });
});
