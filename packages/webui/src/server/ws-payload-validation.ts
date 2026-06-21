export type PayloadValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ModelSwitchPayload {
  provider: string;
  model: string;
}

export function validateModelSwitchPayload(payload: unknown): PayloadValidationResult<ModelSwitchPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'model.switch payload must be an object with string provider and model' };
  }
  const provider = payload['provider'];
  const model = payload['model'];
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.provider must be a non-empty string' };
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.model must be a non-empty string' };
  }
  return { ok: true, value: { provider, model } };
}

export interface PrefsUpdatePayload {
  prefs: Record<string, unknown>;
}

const AUTONOMY_VALUES = new Set(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel']);

export interface MailboxMessagesPayload {
  limit?: number;
  agentId?: string;
  unreadOnly?: boolean;
}

export function validateMailboxMessagesPayload(payload: unknown): PayloadValidationResult<MailboxMessagesPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.messages payload must be an object when provided' };
  }
  const limit = payload['limit'];
  const agentId = payload['agentId'];
  const unreadOnly = payload['unreadOnly'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    return { ok: false, message: 'mailbox.messages payload.limit must be a positive number when provided' };
  }
  if (agentId !== undefined && typeof agentId !== 'string') {
    return { ok: false, message: 'mailbox.messages payload.agentId must be a string when provided' };
  }
  if (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') {
    return { ok: false, message: 'mailbox.messages payload.unreadOnly must be a boolean when provided' };
  }
  return { ok: true, value: { limit, agentId, unreadOnly } };
}

export interface MailboxAgentsPayload {
  onlineOnly?: boolean;
}

export function validateMailboxAgentsPayload(payload: unknown): PayloadValidationResult<MailboxAgentsPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.agents payload must be an object when provided' };
  }
  const onlineOnly = payload['onlineOnly'];
  if (onlineOnly !== undefined && typeof onlineOnly !== 'boolean') {
    return { ok: false, message: 'mailbox.agents payload.onlineOnly must be a boolean when provided' };
  }
  return { ok: true, value: { onlineOnly } };
}

export interface MailboxPurgePayload {
  completedMaxAgeMs?: number;
  incompleteMaxAgeMs?: number;
}

export function validateMailboxPurgePayload(payload: unknown): PayloadValidationResult<MailboxPurgePayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.purge payload must be an object when provided' };
  }
  const completedMaxAgeMs = payload['completedMaxAgeMs'];
  const incompleteMaxAgeMs = payload['incompleteMaxAgeMs'];
  if (completedMaxAgeMs !== undefined && (typeof completedMaxAgeMs !== 'number' || !Number.isFinite(completedMaxAgeMs) || completedMaxAgeMs < 0)) {
    return { ok: false, message: 'mailbox.purge payload.completedMaxAgeMs must be a non-negative number when provided' };
  }
  if (incompleteMaxAgeMs !== undefined && (typeof incompleteMaxAgeMs !== 'number' || !Number.isFinite(incompleteMaxAgeMs) || incompleteMaxAgeMs < 0)) {
    return { ok: false, message: 'mailbox.purge payload.incompleteMaxAgeMs must be a non-negative number when provided' };
  }
  return { ok: true, value: { completedMaxAgeMs, incompleteMaxAgeMs } };
}

export interface BrainRiskPayload {
  level: string;
}

const BRAIN_RISK_VALUES = new Set(['off', 'low', 'medium', 'high', 'all']);

export function validateBrainRiskPayload(payload: unknown): PayloadValidationResult<BrainRiskPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.risk payload must be an object with string level' };
  }
  const level = payload['level'];
  if (typeof level !== 'string' || !BRAIN_RISK_VALUES.has(level)) {
    return { ok: false, message: 'brain.risk payload.level must be one of off, low, medium, high, all' };
  }
  return { ok: true, value: { level } };
}

export interface BrainAskPayload {
  question: string;
}

export function validateBrainAskPayload(payload: unknown): PayloadValidationResult<BrainAskPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.ask payload must be an object with string question' };
  }
  const question = payload['question'];
  if (typeof question !== 'string' || question.trim().length === 0) {
    return { ok: false, message: 'brain.ask payload.question must be a non-empty string' };
  }
  return { ok: true, value: { question: question.trim() } };
}

export interface AutonomySwitchPayload {
  mode: string;
}

export function validateAutonomySwitchPayload(payload: unknown): PayloadValidationResult<AutonomySwitchPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'autonomy.switch payload must be an object with string mode' };
  }
  const mode = payload['mode'];
  if (typeof mode !== 'string' || !AUTONOMY_VALUES.has(mode)) {
    return { ok: false, message: 'autonomy.switch payload.mode must be a valid autonomy mode' };
  }
  return { ok: true, value: { mode } };
}

export interface PlanTemplateUsePayload {
  template: string;
}

export function validatePlanTemplateUsePayload(payload: unknown): PayloadValidationResult<PlanTemplateUsePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'plan.template_use payload must be an object with string template' };
  }
  const template = payload['template'];
  if (typeof template !== 'string' || template.trim().length === 0) {
    return { ok: false, message: 'plan.template_use payload.template must be a non-empty string' };
  }
  return { ok: true, value: { template } };
}
const CONTEXT_STRATEGY_VALUES = new Set(['hybrid', 'intelligent', 'selective']);
const CONTEXT_MODE_VALUES = new Set(['balanced', 'frugal', 'deep', 'archival']);
const TOKEN_SAVING_TIER_VALUES = new Set(['off', 'minimal', 'light', 'medium', 'aggressive']);
const ENHANCE_LANGUAGE_VALUES = new Set(['original', 'english']);
const LOG_LEVEL_VALUES = new Set(['debug', 'info', 'warn', 'error']);
const AUDIT_LEVEL_VALUES = new Set(['minimal', 'standard', 'full']);

const BOOLEAN_PREF_KEYS = new Set([
  'yolo',
  'chime',
  'confirmExit',
  'streamFleet',
  'nextPrediction',
  'titleAnimation',
  'enhanceEnabled',
  'featureMcp',
  'featurePlugins',
  'featureMemory',
  'featureSkills',
  'featureModelsRegistry',
  'indexOnStart',
  'contextAutoCompact',
  'tgSessionEnd',
  'tgDelegate',
]);

const NUMBER_PREF_KEYS = new Set([
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'maxIterations',
  'maxConcurrent',
  'enhanceDelayMs',
  'tgLongToolMs',
]);

const ENUM_PREF_KEYS: Record<string, Set<string>> = {
  autonomy: AUTONOMY_VALUES,
  contextStrategy: CONTEXT_STRATEGY_VALUES,
  contextMode: CONTEXT_MODE_VALUES,
  tokenSavingTier: TOKEN_SAVING_TIER_VALUES,
  enhanceLanguage: ENHANCE_LANGUAGE_VALUES,
  logLevel: LOG_LEVEL_VALUES,
  auditLevel: AUDIT_LEVEL_VALUES,
};

function validatePreferenceValue(key: string, value: unknown): string | null {
  if (BOOLEAN_PREF_KEYS.has(key)) {
    return typeof value === 'boolean' ? null : `prefs.update payload.${key} must be a boolean`;
  }
  if (NUMBER_PREF_KEYS.has(key)) {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `prefs.update payload.${key} must be a finite number`;
  }
  const allowed = ENUM_PREF_KEYS[key];
  if (allowed) {
    return typeof value === 'string' && allowed.has(value)
      ? null
      : `prefs.update payload.${key} must be one of: ${Array.from(allowed).join(', ')}`;
  }
  return `prefs.update payload contains unknown preference key: ${key}`;
}

export function validatePrefsUpdatePayload(payload: unknown): PayloadValidationResult<PrefsUpdatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'prefs.update payload must be an object' };
  }
  for (const [key, value] of Object.entries(payload)) {
    const error = validatePreferenceValue(key, value);
    if (error) return { ok: false, message: error };
  }
  return { ok: true, value: { prefs: payload } };
}

export interface SkillsCreatePayload {
  name: string;
  description: string;
  scope: 'project' | 'global';
}

export function validateSkillsCreatePayload(payload: unknown): PayloadValidationResult<SkillsCreatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'skills.create payload must be an object' };
  }
  const name = payload['name'];
  const description = payload['description'];
  const scope = payload['scope'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'Skill name is required' };
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.trim())) {
    return { ok: false, message: 'Skill name must be kebab-case (e.g. my-new-skill)' };
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return { ok: false, message: 'Description/trigger is required' };
  }
  if (scope !== 'project' && scope !== 'global') {
    return { ok: false, message: 'skills.create payload.scope must be project or global' };
  }
  return { ok: true, value: { name, description, scope } };
}

export interface SkillsEditPayload {
  name: string;
  body: string;
}

export function validateSkillsEditPayload(payload: unknown): PayloadValidationResult<SkillsEditPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'skills.edit payload must be an object' };
  }
  const name = payload['name'];
  const body = payload['body'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'Skill name is required' };
  }
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, message: 'Skill body is required' };
  }
  return { ok: true, value: { name, body } };
}

export interface ProcessKillPayload {
  pid: number;
}

export function validateProcessKillPayload(payload: unknown): PayloadValidationResult<ProcessKillPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'process.kill payload must be an object with numeric pid' };
  }
  const pid = payload['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: 'process.kill payload.pid must be a positive integer' };
  }
  return { ok: true, value: { pid } };
}

export interface WorkingDirSetPayload {
  path: string;
}

export function validateWorkingDirSetPayload(payload: unknown): PayloadValidationResult<WorkingDirSetPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'working_dir.set payload must be an object with string path' };
  }
  const newPath = payload['path'];
  if (typeof newPath !== 'string' || newPath.trim().length === 0) {
    return { ok: false, message: 'working_dir.set payload.path must be a non-empty string' };
  }
  return { ok: true, value: { path: newPath } };
}

export interface ModeSwitchPayload {
  id: string;
}

export function validateModeSwitchPayload(payload: unknown): PayloadValidationResult<ModeSwitchPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'mode.switch payload must be an object with string id' };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'mode.switch payload.id must be a non-empty string' };
  }
  return { ok: true, value: { id } };
}

export interface ContextModeIdPayload {
  id: string;
}

function validateContextModeIdPayload(
  payload: unknown,
  type: 'context.mode.switch' | 'context.mode.delete',
): PayloadValidationResult<ContextModeIdPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: `${type} payload must be an object with string id` };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: `${type} payload.id must be a non-empty string` };
  }
  return { ok: true, value: { id } };
}

export function validateContextModeSwitchPayload(payload: unknown): PayloadValidationResult<ContextModeIdPayload> {
  return validateContextModeIdPayload(payload, 'context.mode.switch');
}

export function validateContextModeDeletePayload(payload: unknown): PayloadValidationResult<ContextModeIdPayload> {
  return validateContextModeIdPayload(payload, 'context.mode.delete');
}

export interface ContextModeCreatePayload {
  id: string;
  name: string;
  description: string;
  thresholds: { warn: number; soft: number; hard: number };
  preserveK: number;
  eliseThreshold: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateContextModeCreatePayload(payload: unknown): PayloadValidationResult<ContextModeCreatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'context.mode.create payload must be an object' };
  }
  const id = payload['id'];
  const name = payload['name'];
  const description = payload['description'];
  const thresholds = payload['thresholds'];
  const preserveK = payload['preserveK'];
  const eliseThreshold = payload['eliseThreshold'];

  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'context.mode.create payload.id must be a non-empty string' };
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'context.mode.create payload.name must be a non-empty string' };
  }
  if (typeof description !== 'string') {
    return { ok: false, message: 'context.mode.create payload.description must be a string' };
  }
  if (!isRecord(thresholds)) {
    return { ok: false, message: 'context.mode.create payload.thresholds must be an object with warn/soft/hard numbers' };
  }
  if (!isFiniteNumber(thresholds['warn']) || !isFiniteNumber(thresholds['soft']) || !isFiniteNumber(thresholds['hard'])) {
    return { ok: false, message: 'context.mode.create payload.thresholds.warn/soft/hard must be finite numbers' };
  }
  if (!isFiniteNumber(preserveK)) {
    return { ok: false, message: 'context.mode.create payload.preserveK must be a finite number' };
  }
  if (!isFiniteNumber(eliseThreshold)) {
    return { ok: false, message: 'context.mode.create payload.eliseThreshold must be a finite number' };
  }
  return {
    ok: true,
    value: {
      id,
      name,
      description,
      thresholds: { warn: thresholds['warn'], soft: thresholds['soft'], hard: thresholds['hard'] },
      preserveK,
      eliseThreshold,
    },
  };
}

export interface ContextModeUpdatePayload {
  id: string;
  name?: string;
  description?: string;
  thresholds?: { warn?: number; soft?: number; hard?: number };
  preserveK?: number;
  eliseThreshold?: number;
}

export function validateContextModeUpdatePayload(payload: unknown): PayloadValidationResult<ContextModeUpdatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'context.mode.update payload must be an object' };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'context.mode.update payload.id must be a non-empty string' };
  }

  const name = payload['name'];
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, message: 'context.mode.update payload.name must be a string when provided' };
  }

  const description = payload['description'];
  if (description !== undefined && typeof description !== 'string') {
    return { ok: false, message: 'context.mode.update payload.description must be a string when provided' };
  }

  const thresholds = payload['thresholds'];
  let validatedThresholds: ContextModeUpdatePayload['thresholds'];
  if (thresholds !== undefined) {
    if (!isRecord(thresholds)) {
      return { ok: false, message: 'context.mode.update payload.thresholds must be an object when provided' };
    }
    for (const key of ['warn', 'soft', 'hard'] as const) {
      const val = thresholds[key];
      if (val !== undefined && !isFiniteNumber(val)) {
        return { ok: false, message: `context.mode.update payload.thresholds.${key} must be a finite number when provided` };
      }
    }
    validatedThresholds = {
      warn: typeof thresholds['warn'] === 'number' ? thresholds['warn'] : undefined,
      soft: typeof thresholds['soft'] === 'number' ? thresholds['soft'] : undefined,
      hard: typeof thresholds['hard'] === 'number' ? thresholds['hard'] : undefined,
    };
  }

  const preserveK = payload['preserveK'];
  if (preserveK !== undefined && !isFiniteNumber(preserveK)) {
    return { ok: false, message: 'context.mode.update payload.preserveK must be a finite number when provided' };
  }

  const eliseThreshold = payload['eliseThreshold'];
  if (eliseThreshold !== undefined && !isFiniteNumber(eliseThreshold)) {
    return { ok: false, message: 'context.mode.update payload.eliseThreshold must be a finite number when provided' };
  }

  return {
    ok: true,
    value: {
      id,
      name: typeof name === 'string' ? name : undefined,
      description: typeof description === 'string' ? description : undefined,
      thresholds: validatedThresholds,
      preserveK: typeof preserveK === 'number' ? preserveK : undefined,
      eliseThreshold: typeof eliseThreshold === 'number' ? eliseThreshold : undefined,
    },
  };
}

export interface ShellOpenPayload {
  path: string;
  target?: 'file' | 'terminal';
}

export function validateShellOpenPayload(payload: unknown): PayloadValidationResult<ShellOpenPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'shell.open payload must be an object with string path' };
  }
  const path = payload['path'];
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, message: 'shell.open payload.path must be a non-empty string' };
  }
  const target = payload['target'];
  if (target !== undefined && target !== 'file' && target !== 'terminal') {
    return { ok: false, message: 'shell.open payload.target must be "file" or "terminal" when provided' };
  }
  return { ok: true, value: { path, target: target as ShellOpenPayload['target'] } };
}

export interface GitDiffPayload {
  path: string;
}

export function validateGitDiffPayload(payload: unknown): PayloadValidationResult<GitDiffPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'git.diff payload must be an object' };
  }
  const path = payload['path'];
  if (path === undefined || path === null) {
    return { ok: true, value: { path: '' } };
  }
  if (typeof path !== 'string') {
    return { ok: false, message: 'git.diff payload.path must be a string when provided' };
  }
  return { ok: true, value: { path } };
}

export interface ProjectsAddPayload {
  root: string;
  name?: string;
}

export function validateProjectsAddPayload(payload: unknown): PayloadValidationResult<ProjectsAddPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'projects.add payload must be an object with string root' };
  }
  const root = payload['root'];
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, message: 'projects.add payload.root must be a non-empty string' };
  }
  const name = payload['name'];
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, message: 'projects.add payload.name must be a string when provided' };
  }
  return { ok: true, value: { root, name: typeof name === 'string' ? name : undefined } };
}

export interface ProjectsSelectPayload {
  root: string;
  name?: string;
}

export function validateProjectsSelectPayload(payload: unknown): PayloadValidationResult<ProjectsSelectPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'projects.select payload must be an object with string root' };
  }
  const root = payload['root'];
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, message: 'projects.select payload.root must be a non-empty string' };
  }
  const name = payload['name'];
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, message: 'projects.select payload.name must be a string when provided' };
  }
  return { ok: true, value: { root, name: typeof name === 'string' ? name : undefined } };
}

