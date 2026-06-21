import * as fs from 'node:fs/promises';
import { atomicWrite } from './atomic-write.js';

export type JsonObject = Record<string, unknown>;
export type JsonPathSegment = string | number;
export type JsonPath = readonly JsonPathSegment[];

export async function readJsonObjectFile(filePath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function jsonObjectFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonObjectFile(filePath: string, value: JsonObject): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function updateJsonObjectFile(
  filePath: string,
  mutator: (config: JsonObject) => void | JsonObject | Promise<void | JsonObject>,
): Promise<JsonObject> {
  const config = await readJsonObjectFile(filePath);
  const maybeNext = await mutator(config);
  const next = maybeNext && isJsonObject(maybeNext) ? maybeNext : config;
  await writeJsonObjectFile(filePath, next);
  return next;
}

export function getJsonPath(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function setJsonPath(root: JsonObject, path: JsonPath, value: unknown): JsonObject {
  if (path.length === 0) {
    if (!isJsonObject(value)) throw new Error('Root config value must be an object');
    return value;
  }
  const parent = ensureJsonParent(root, path);
  const leaf = lastPathSegment(path);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent)) throw new Error(`Cannot set numeric segment ${leaf} on non-array parent`);
    parent[leaf] = value;
  } else {
    if (!isJsonObject(parent)) throw new Error(`Cannot set property ${leaf} on non-object parent`);
    parent[leaf] = value;
  }
  return root;
}

export function removeJsonPath(root: JsonObject, path: JsonPath): boolean {
  if (path.length === 0) return false;
  const parent = getJsonPath(root, path.slice(0, -1));
  const leaf = lastPathSegment(path);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent) || leaf < 0 || leaf >= parent.length) return false;
    parent.splice(leaf, 1);
    return true;
  }
  if (!isJsonObject(parent) || !(leaf in parent)) return false;
  delete parent[leaf];
  return true;
}

export async function setJsonPathInFile(filePath: string, path: JsonPath, value: unknown): Promise<JsonObject> {
  return updateJsonObjectFile(filePath, (config) => setJsonPath(config, path, value));
}

export async function removeJsonPathInFile(filePath: string, path: JsonPath): Promise<JsonObject> {
  return updateJsonObjectFile(filePath, (config) => {
    removeJsonPath(config, path);
  });
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastPathSegment(path: JsonPath): JsonPathSegment {
  const segment = path[path.length - 1];
  if (segment === undefined) throw new Error('Invalid empty JSON path');
  return segment;
}

function ensureJsonParent(root: JsonObject, path: JsonPath): JsonObject | unknown[] {
  let current: JsonObject | unknown[] = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const nextSegment = path[i + 1];
    if (segment === undefined) throw new Error('Invalid empty JSON path segment');
    const nextContainer = typeof nextSegment === 'number' ? [] : {};

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) throw new Error(`Cannot traverse numeric segment ${segment} on non-array parent`);
      if (!isJsonObject(current[segment]) && !Array.isArray(current[segment])) current[segment] = nextContainer;
      current = current[segment] as JsonObject | unknown[];
    } else {
      if (!isJsonObject(current)) throw new Error(`Cannot traverse property ${segment} on non-object parent`);
      if (!isJsonObject(current[segment]) && !Array.isArray(current[segment])) current[segment] = nextContainer;
      current = current[segment] as JsonObject | unknown[];
    }
  }
  return current;
}
