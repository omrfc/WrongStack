/**
 * PipelineRegistry — dynamic pipeline registration for agent runs.
 *
 * Unlike the static AgentPipelines interface, PipelineRegistry allows
 * plugins to register new pipelines and extend existing ones at runtime.
 */

import { Pipeline, type ReadonlyPipeline, type Middleware } from './pipeline.js';

export interface RegisteredPipeline<T = unknown> {
  name: string;
  pipeline: Pipeline<T>;
  description?: string;
}

export class PipelineRegistry {
  private readonly pipelines = new Map<string, RegisteredPipeline>();

  /**
   * Register a new pipeline. Throws if the name is already registered.
   */
  register<T>(name: string, pipeline: Pipeline<T>, description?: string): void {
    if (this.pipelines.has(name)) {
      throw new Error(`PipelineRegistry: pipeline "${name}" already registered`);
    }
    this.pipelines.set(name, { name, pipeline: pipeline as Pipeline<unknown>, description });
  }

  /**
   * Register a pipeline only if it doesn't exist.
   */
  ensure<T>(name: string, pipeline: Pipeline<T>, description?: string): void {
    if (!this.pipelines.has(name)) {
      this.register(name, pipeline, description);
    }
  }

  /**
   * Get a pipeline by name. Returns undefined if not found.
   */
  get<T>(name: string): Pipeline<T> | undefined {
    return this.pipelines.get(name)?.pipeline as Pipeline<T> | undefined;
  }

  /**
   * Get a read-only view of a pipeline.
   */
  getReadonly<T>(name: string): ReadonlyPipeline<T> | undefined {
    const p = this.get<T>(name);
    return p?.asReadonly();
  }

  /**
   * Check if a pipeline is registered.
   */
  has(name: string): boolean {
    return this.pipelines.has(name);
  }

  /**
   * List all registered pipeline names.
   */
  list(): string[] {
    return Array.from(this.pipelines.keys());
  }

  /**
   * Add middleware to an existing pipeline. Throws if pipeline not found.
   */
  use<T>(name: string, mw: Middleware<T>): void {
    const p = this.get<T>(name);
    if (!p) {
      throw new Error(`PipelineRegistry: pipeline "${name}" not found`);
    }
    p.use(mw as Middleware<unknown>);
  }

  /**
   * Remove a pipeline. Returns true if it existed.
   */
  unregister(name: string): boolean {
    return this.pipelines.delete(name);
  }

  /**
   * Get all pipelines as a record (for backward compatibility).
   */
  toRecord(): Record<string, Pipeline<unknown>> {
    const record: Record<string, Pipeline<unknown>> = {};
    for (const [name, reg] of this.pipelines) {
      record[name] = reg.pipeline;
    }
    return record;
  }

  /**
   * Get all read-only pipelines as a record (for PluginAPI).
   */
  toReadonlyRecord(): Record<string, ReadonlyPipeline<unknown>> {
    const record: Record<string, ReadonlyPipeline<unknown>> = {};
    for (const [name, reg] of this.pipelines) {
      record[name] = reg.pipeline.asReadonly();
    }
    return record;
  }
}
