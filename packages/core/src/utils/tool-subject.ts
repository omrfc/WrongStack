const GLOB_METACHARACTERS = /[*?[\]]/g;

export function escapeGlobSubject(value: string): string {
  return value.replace(GLOB_METACHARACTERS, (char) => `\\${char}`);
}

export function normalizePathSubject(value: string): string {
  return escapeGlobSubject(value.replace(/\\/g, '/'));
}

export function isPathSubjectKey(subjectKey: string): boolean {
  return subjectKey === 'path' || subjectKey === 'file' || subjectKey === 'files';
}

export function subjectForToolInput(
  toolName: string,
  input: unknown,
  subjectKey?: string,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  if (subjectKey) {
    const value = obj[subjectKey];
    if (typeof value === 'string') {
      return isPathSubjectKey(subjectKey) ? normalizePathSubject(value) : escapeGlobSubject(value);
    }
  }

  if (toolName === 'bash' && typeof obj.command === 'string') {
    return escapeGlobSubject(obj.command);
  }
  if (typeof obj.path === 'string') {
    return normalizePathSubject(obj.path);
  }
  if (typeof obj.url === 'string') {
    return escapeGlobSubject(obj.url);
  }
  if (typeof obj.name === 'string') {
    return escapeGlobSubject(obj.name);
  }
  return undefined;
}
