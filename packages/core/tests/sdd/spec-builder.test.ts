import { describe, expect, it, vi } from 'vitest';
import { AISpecBuilder } from '../../src/sdd/spec-builder.js';
import type { SpecStore } from '../../src/sdd/spec-store.js';
import type { Specification } from '../../src/types/spec.js';

function mockStore(): SpecStore {
  const saved = new Map<string, Specification>();
  return {
    save: vi.fn(async (spec: Specification) => { saved.set(spec.id, spec); }),
    load: vi.fn(async (id: string) => saved.get(id) ?? null),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    exists: vi.fn(async () => false),
    createDraft: vi.fn(async () => ({ id: 'draft', title: '', version: '0.1.0', status: 'draft' as const, overview: '', sections: [], requirements: [], createdAt: 0, updatedAt: 0 })),
    update: vi.fn(async () => null),
  };
}

describe('AISpecBuilder', () => {
  it('starts in questioning phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.getPhase()).toBe('questioning');
  });

  it('startSession sets title and intent', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Auth System', 'Add OAuth2 login');
    const session = builder.getSession();
    expect(session.title).toBe('Auth System');
    expect(session.userIntent).toBe('Add OAuth2 login');
    expect(session.phase).toBe('questioning');
  });

  it('getAIPrompt returns questioning prompt with budget info', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 3, maxQuestions: 8 });
    builder.startSession('Test Feature');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('SDD Spec Builder');
    expect(prompt).toContain('Test Feature');
    expect(prompt).toContain('Questioning');
    expect(prompt).toContain('remaining budget');
    expect(prompt).toContain('**Minimum required:** 3');
  });

  it('addAnswer increments question count', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 2 });
    builder.startSession('Test');
    builder.addAnswer('What auth?', 'OAuth2');
    builder.addAnswer('Roles?', 'Admin/User');
    expect(builder.getSession().questionCount).toBe(2);
    expect(builder.hasMetMinimumQuestions()).toBe(true);
  });

  it('shouldContinueQuestioning returns false at max', () => {
    const builder = new AISpecBuilder({ store: mockStore(), maxQuestions: 3 });
    builder.startSession('Test');
    builder.addAnswer('Q1', 'A1');
    builder.addAnswer('Q2', 'A2');
    builder.addAnswer('Q3', 'A3');
    expect(builder.shouldContinueQuestioning()).toBe(false);
  });

  it('hasMetMinimumQuestions returns false below min', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 5 });
    builder.startSession('Test');
    builder.addAnswer('Q1', 'A1');
    expect(builder.hasMetMinimumQuestions()).toBe(false);
  });

  it('setSpec moves to spec_review phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    expect(builder.getPhase()).toBe('spec_review');
    expect(builder.getSession().spec).toBe(spec);
  });

  it('approve transitions through phases correctly', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    expect(builder.getPhase()).toBe('spec_review');

    builder.approve(); // spec_review → implementation
    expect(builder.getPhase()).toBe('implementation');

    builder.setImplementation('Do stuff');
    expect(builder.getPhase()).toBe('task_review');

    builder.approve(); // task_review → executing
    expect(builder.getPhase()).toBe('executing');

    builder.approve(); // executing → done
    expect(builder.getPhase()).toBe('done');
  });

  it('approve throws if no spec generated in questioning phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    expect(() => builder.approve()).toThrow('Cannot approve: no spec generated yet.');
  });

  it('saveSpec persists to store', async () => {
    const store = mockStore();
    const builder = new AISpecBuilder({ store });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    await builder.saveSpec();
    expect(store.save).toHaveBeenCalledWith(spec);
  });

  it('saveSpec throws if no spec', async () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    await expect(builder.saveSpec()).rejects.toThrow('No spec to save.');
  });

  it('extractJSON handles ```json blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'Here is the spec:\n```json\n{"title":"Test"}\n```\nDone.';
    const result = builder.extractJSON(text);
    expect(result).toBe('{"title":"Test"}');
  });

  it('extractJSON handles raw JSON objects', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'The spec is: {"title":"Test","overview":"Hello"}';
    const result = builder.extractJSON(text);
    expect(result).toBe('{"title":"Test","overview":"Hello"}');
  });

  it('extractJSON returns null for no JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('no json here')).toBeNull();
  });

  it('hasSpecInOutput detects JSON blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.hasSpecInOutput('```json\n{"title":"T"}\n```')).toBe(true);
    expect(builder.hasSpecInOutput('no json')).toBe(false);
  });

  it('tryParseSpecFromOutput parses valid spec JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('My Feature');
    const text = `Here's the spec:
\`\`\`json
{
  "title": "Auth System",
  "overview": "User authentication with OAuth2",
  "requirements": [
    {
      "id": "REQ-1",
      "type": "functional",
      "priority": "critical",
      "description": "User can login with OAuth2",
      "acceptanceCriteria": ["Login works"]
    }
  ]
}
\`\`\``;
    const spec = builder.tryParseSpecFromOutput(text);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe('Auth System');
    expect(spec!.requirements).toHaveLength(1);
    expect(spec!.requirements[0]!.priority).toBe('critical');
  });

  it('tryParseSpecFromOutput returns null for invalid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.tryParseSpecFromOutput('no json at all')).toBeNull();
  });

  it('parseSpecFromJSON normalizes missing fields', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Fallback Title');
    const spec = builder.parseSpecFromJSON('{"overview":"minimal"}');
    expect(spec.title).toBe('Fallback Title');
    expect(spec.overview).toBe('minimal');
    expect(spec.requirements).toHaveLength(0);
    expect(spec.sections).toHaveLength(0);
  });

  it('parseSpecFromJSON throws on invalid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(() => builder.parseSpecFromJSON('not json')).toThrow('Invalid JSON');
  });

  it('extractJSONArray handles code blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'Tasks:\n```json\n[{"title":"T1"},{"title":"T2"}]\n```';
    const result = builder.extractJSONArray(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveLength(2);
  });

  it('getAIPrompt includes conversation history after answers', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 1, maxQuestions: 5 });
    builder.startSession('Test');
    builder.addAnswer('What auth method?', 'OAuth2');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('What auth method?');
    expect(prompt).toContain('OAuth2');
    expect(prompt).toContain('Conversation so far');
  });

  it('getAIPrompt for spec_review includes requirements', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Auth',
      version: '0.1.0',
      status: 'draft',
      overview: 'Auth system',
      sections: [],
      requirements: [
        { id: 'REQ-1', type: 'functional', priority: 'critical', description: 'Login', acceptanceCriteria: [] },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Spec Review');
    expect(prompt).toContain('Login');
    expect(prompt).toContain('[critical]');
  });

  it('getAIPrompt for implementation phase includes instructions', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    builder.approve(); // → implementation
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Implementation Planning');
    expect(prompt).toContain('Architecture decisions');
  });

  it('projectContext is included in questioning prompt', () => {
    const builder = new AISpecBuilder({
      store: mockStore(),
      projectContext: 'Project: my-app\nDependencies: express, zod',
    });
    builder.startSession('Test');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Project Context');
    expect(prompt).toContain('express, zod');
  });

  it('setImplementation moves to task_review', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    builder.setImplementation('Step 1: do stuff\nStep 2: more stuff');
    expect(builder.getPhase()).toBe('task_review');
    expect(builder.getSession().implementation).toContain('Step 1');
  });

  it('markDone moves to done phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    builder.markDone();
    expect(builder.getPhase()).toBe('done');
    expect(builder.getAIPrompt()).toContain('completed');
  });
});
