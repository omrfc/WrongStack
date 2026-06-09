/**
 * Shared type-level utilities used across WrongStack packages.
 *
 * These are pure type helpers with no runtime footprint. They solve
 * recurring TypeScript pattern problems that the standard library
 * types (Pick, Omit, Partial, etc.) don't handle well — particularly
 * around discriminated unions and distribution.
 */

/**
 * Distributive version of the built-in {@link Omit}.
 *
 * **Why this exists:** The standard `Omit<T, K>` is defined as
 * `Pick<T, Exclude<keyof T, K>>`. When `T` is a discriminated union,
 * `keyof T` returns the *intersection* of all members' keys — not
 * what you want. `Omit<{ a: 1 } | { b: 2 }, 'id'>` collapses to `{}`.
 *
 * `DistributiveOmit` forces distribution over each union member via
 * a conditional type (`T extends unknown`), yielding the expected
 * result: `Omit<{ a: 1 }, 'id'> | Omit<{ b: 2 }, 'id'>`.
 *
 * @example
 * ```ts
 * type Entry = { id: number; kind: 'user'; text: string }
 *            | { id: number; kind: 'tool'; name: string };
 *
 * type Broken  = Omit<Entry, 'id'>;            // {}
 * type Working = DistributiveOmit<Entry, 'id'>; // { kind: 'user'; text } | { kind: 'tool'; name }
 * ```
 */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Distributive version of the built-in {@link Pick}.
 *
 * Same problem as {@link DistributiveOmit}: `Pick<Union, K>` collapses
 * because `keyof Union` is the intersection of all members' keys.
 *
 * @example
 * ```ts
 * type Entry = { id: number; kind: 'user'; text: string }
 *            | { id: number; kind: 'tool'; name: string; ok: boolean };
 *
 * type Broken  = Pick<Entry, 'id' | 'kind'>;            // { id: number; kind: never }
 * type Working = DistributivePick<Entry, 'id' | 'kind'>; // { id; kind: 'user' } | { id; kind: 'tool' }
 * ```
 */
export type DistributivePick<T, K extends keyof any> = T extends unknown
  ? Pick<T, K & keyof T>
  : never;
