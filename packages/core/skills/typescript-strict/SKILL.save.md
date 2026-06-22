# TypeScript Strict Mode — WrongStack (Compact)

Strict TypeScript patterns for WrongStack: exhaustive switch, branded types, discriminated unions, and `noUncheckedIndexedAccess`.

## Rules

1. Never silence errors with `as any` or double assertions — validate or narrow values at trust boundaries.
2. Don't use `!` non-null assertion — silence the type checker without explanation.
3. Always annotate return types on exported functions.
4. Use `Promise<unknown>` or generics instead of `Promise<any>`.
5. Be specific with types — `Function` and `Object` are too broad.
6. Enable `noUncheckedIndexedAccess` — always handle the `undefined` case.

## Key patterns

- **Exhaustive switch**: Create `assertNever(x: never)` and use it in the `default` branch of every switch on a union.
- **Branded types**: `type UserId = string & { readonly __brand: 'UserId' }` for invariant string types.
- **Discriminated unions**: Prefer `{ status: 'success'; data: T } | { status: 'error'; error: E }` over optional fields.
- **noUncheckedIndexedAccess**: Use `items.at(0)` or `if (items[0] !== undefined)` — never assume array access succeeds.
