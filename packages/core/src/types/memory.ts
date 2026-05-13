export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

export interface MemoryEntry {
  scope: MemoryScope;
  text: string;
  ts: string;
}

export interface MemoryStore {
  readAll(): Promise<string>;
  read(scope: MemoryScope): Promise<string>;
  remember(text: string, scope?: MemoryScope): Promise<void>;
  forget(query: string, scope?: MemoryScope): Promise<number>;
  consolidate(scope: MemoryScope): Promise<void>;
  clear(scope?: MemoryScope): Promise<void>;
}
