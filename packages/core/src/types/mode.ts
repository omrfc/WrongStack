export interface Mode {
  id: string;
  name: string;
  description: string;
  /** Additional prompt text injected into system prompt when mode is active */
  prompt: string;
  /** Tags for tool_search filtering */
  tags?: string[];
  /** Tools that should be prioritized/highlighted when this mode is active */
  toolPreferences?: string[];
}

export interface ModeManifest {
  modes: Mode[];
  defaultMode?: string;
}

export interface ModeStore {
  getActiveMode(): Promise<Mode | null>;
  setActiveMode(modeId: string | null): Promise<void>;
  listModes(): Promise<Mode[]>;
  getMode(modeId: string): Promise<Mode | null>;
}

export interface ModeConfig {
  directory: string;
}

export const DEFAULT_MODES: Mode[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'General-purpose coding assistant',
    prompt: '',
    tags: ['general'],
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description: 'Focus on code quality, best practices, and potential bugs',
    prompt: `## Code Reviewer Mode

When reviewing code:
- Look for potential bugs, race conditions, and edge cases
- Check for security vulnerabilities (SQL injection, XSS, CSRF, etc.)
- Evaluate error handling completeness
- Assess code readability and maintainability
- Check for performance anti-patterns
- Verify test coverage for critical paths
- Ensure naming conventions are followed`,
    tags: ['review', 'quality', 'security'],
    toolPreferences: ['read', 'grep', 'git', 'diff', 'test'],
  },
  {
    id: 'code-auditor',
    name: 'Code Auditor',
    description: 'Security-focused code analysis',
    prompt: `## Code Auditor Mode

When auditing code for security:
- Identify injection vulnerabilities (SQL, Command, XSS, LDAP)
- Check authentication and authorization patterns
- Look for sensitive data exposure (secrets, PII in logs)
- Verify cryptographic implementations
- Check for insecure dependencies or configurations
- Assess input validation and output encoding
- Look for timing attacks and information leakage`,
    tags: ['security', 'audit', 'compliance'],
    toolPreferences: ['grep', 'read', 'audit', 'bash'],
  },
  {
    id: 'architect',
    name: 'Software Architect',
    description: 'Design patterns, scalability, and system design',
    prompt: `## Architect Mode

When designing or reviewing architecture:
- Evaluate scalability and future growth
- Check for appropriate design patterns
- Assess coupling and cohesion
- Look forSOLID principle violations
- Evaluate data modeling decisions
- Check for eventual consistency issues
- Assess API design and contract stability
- Consider operational aspects (monitoring, logging, deployment)`,
    tags: ['architecture', 'design', 'scalability'],
    toolPreferences: ['read', 'glob', 'tree', 'diff'],
  },
  {
    id: 'debugger',
    name: 'Debugger',
    description: 'Root cause analysis and error investigation',
    prompt: `## Debugger Mode

When investigating bugs:
- Reproduce the issue with minimal steps
- Check error messages and stack traces thoroughly
- Look for related logs and historical context
- Verify assumptions about data flow
- Check for race conditions in async code
- Validate environment and configuration
- Use binary search to isolate the root cause
- Verify fixes with tests before considering done`,
    tags: ['debug', 'investigation', 'error-resolution'],
    toolPreferences: ['read', 'grep', 'bash', 'logs', 'test'],
  },
  {
    id: 'tester',
    name: 'QA Engineer',
    description: 'Test coverage, edge cases, and quality assurance',
    prompt: `## Tester Mode

When testing or writing tests:
- Cover happy path and error paths equally
- Think about edge cases and boundary conditions
- Check for missing null/undefined handling tests
- Verify error messages are tested
- Look for race condition tests in async code
- Assess mutation testing opportunities
- Check for integration test gaps
- Verify test isolation and cleanup`,
    tags: ['testing', 'qa', 'quality'],
    toolPreferences: ['read', 'grep', 'test', 'bash'],
  },
  {
    id: 'devops',
    name: 'DevOps Engineer',
    description: 'Infrastructure, deployment, and operations',
    prompt: `## DevOps Mode

When working on infrastructure:
- Check for containerization and deployment readiness
- Verify CI/CD pipeline configurations
- Assess monitoring and alerting setup
- Look for health check endpoints
- Check for graceful shutdown handling
- Verify backup and disaster recovery plans
- Assess secrets management
- Check for resource limits and quotas`,
    tags: ['devops', 'infrastructure', 'operations'],
    toolPreferences: ['read', 'bash', 'grep', 'logs', 'git'],
  },
  {
    id: 'refactorer',
    name: 'Refactorer',
    description: 'Code improvement and modernization',
    prompt: `## Refactorer Mode

When refactoring code:
- Maintain existing behavior — tests must pass before and after
- Make one change at a time, verify after each
- Prefer small, focused commits
- Preserve API contracts unless explicitly changing
- Remove dead code and comments
- Improve naming as you go
- Don't mix formatting changes with logic changes
- Keep performance in mind — don't regress`,
    tags: ['refactor', 'modernization', 'improvement'],
    toolPreferences: ['read', 'edit', 'test', 'git', 'grep'],
  },
];
