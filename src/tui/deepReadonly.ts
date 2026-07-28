/**
 * Matches the shape valtio's useSnapshot() produces (deep-readonly, arrays
 * included) so helpers that only read a snapshot value don't need a cast at
 * every call site.
 */
export type DeepReadonly<T> = T extends Date | RegExp | Map<unknown, unknown> | Set<unknown>
  ? T
  : T extends (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
