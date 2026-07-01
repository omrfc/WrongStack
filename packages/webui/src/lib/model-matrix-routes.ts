export interface ModelMatrixRouteRole {
  role: string;
  name: string;
}

export interface ModelMatrixRouteGroup {
  phase: string;
  label: string;
  roles: readonly ModelMatrixRouteRole[];
}

export const MODEL_MATRIX_DEFAULT_ROUTE = '*';

export const MODEL_MATRIX_ROUTE_GROUPS = [
  {
    phase: 'discovery',
    label: 'Discovery',
    roles: [
      { role: 'explore', name: 'Explore' },
      { role: 'search', name: 'Search' },
      { role: 'research', name: 'Research' },
    ],
  },
  {
    phase: 'planning',
    label: 'Planning',
    roles: [
      { role: 'analyst', name: 'Analyst' },
      { role: 'planner', name: 'Planner' },
      { role: 'architect', name: 'Architect' },
      { role: 'critic', name: 'Critic' },
      { role: 'refactor-planner', name: 'Refactor Planner' },
    ],
  },
  {
    phase: 'build',
    label: 'Build',
    roles: [
      { role: 'executor', name: 'Executor' },
      { role: 'refactor', name: 'Refactor' },
      { role: 'simplifier', name: 'Simplifier' },
      { role: 'migration', name: 'Migration' },
      { role: 'vision', name: 'Vision' },
      { role: 'debugger', name: 'Debugger' },
      { role: 'tracer', name: 'Tracer' },
    ],
  },
  {
    phase: 'verify',
    label: 'Verify',
    roles: [
      { role: 'test', name: 'Test' },
      { role: 'e2e', name: 'E2E' },
      { role: 'browser', name: 'Browser' },
      { role: 'performance', name: 'Performance' },
      { role: 'chaos', name: 'Chaos' },
      { role: 'security-scanner', name: 'Security Scanner' },
      { role: 'bug-hunter', name: 'Bug Hunter' },
      { role: 'audit-log', name: 'Audit Log' },
    ],
  },
  {
    phase: 'review',
    label: 'Review',
    roles: [
      { role: 'code-reviewer', name: 'Code Reviewer' },
      { role: 'security-reviewer', name: 'Security Reviewer' },
      { role: 'accessibility', name: 'Accessibility' },
      { role: 'compliance', name: 'Compliance' },
    ],
  },
  {
    phase: 'domain',
    label: 'Domain',
    roles: [
      { role: 'database', name: 'Database' },
      { role: 'api', name: 'API' },
      { role: 'auth', name: 'Auth' },
      { role: 'data', name: 'Data' },
      { role: 'frontend', name: 'Frontend' },
      { role: 'backend', name: 'Backend' },
      { role: 'designer', name: 'Designer' },
    ],
  },
  {
    phase: 'knowledge',
    label: 'Knowledge',
    roles: [
      { role: 'document', name: 'Document' },
      { role: 'uml', name: 'UML' },
      { role: 'i18n', name: 'I18n' },
      { role: 'prompt', name: 'Prompt' },
    ],
  },
  {
    phase: 'delivery',
    label: 'Delivery',
    roles: [
      { role: 'git', name: 'Git' },
      { role: 'release', name: 'Release' },
      { role: 'devops', name: 'DevOps' },
      { role: 'observability', name: 'Observability' },
      { role: 'dependency', name: 'Dependency' },
    ],
  },
  {
    phase: 'meta',
    label: 'Meta',
    roles: [
      { role: 'skill-manage', name: 'Skill Manager' },
      { role: 'self-improving', name: 'Self-Improving' },
      { role: 'context', name: 'Context' },
      { role: 'cost', name: 'Cost' },
      { role: 'tech-stack', name: 'Tech Stack Validator' },
    ],
  },
] as const satisfies readonly ModelMatrixRouteGroup[];

export const MODEL_MATRIX_PHASE_ROUTES = MODEL_MATRIX_ROUTE_GROUPS.map((group) => group.phase);

export const MODEL_MATRIX_ROUTE_ROLES: readonly ModelMatrixRouteRole[] = MODEL_MATRIX_ROUTE_GROUPS.flatMap(
  (group) => [...group.roles],
);

export const MODEL_MATRIX_ROLE_ROUTES = MODEL_MATRIX_ROUTE_ROLES.map((role) => role.role);

export const MODEL_MATRIX_KNOWN_ROUTES = [
  MODEL_MATRIX_DEFAULT_ROUTE,
  ...MODEL_MATRIX_PHASE_ROUTES,
  ...MODEL_MATRIX_ROLE_ROUTES,
];

export function formatModelMatrixRouteLabel(route: string): string {
  if (route === MODEL_MATRIX_DEFAULT_ROUTE) return 'Default (*)';
  const phase = MODEL_MATRIX_ROUTE_GROUPS.find((group) => group.phase === route);
  if (phase) return `Phase: ${phase.label} (${phase.phase})`;
  const role = MODEL_MATRIX_ROUTE_ROLES.find((candidate) => candidate.role === route);
  return role ? `${role.name} (${role.role})` : `Custom: ${route}`;
}
