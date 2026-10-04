/** `T` or `null` — for values that are explicitly "absent" (e.g. nullable DB columns). */
export type Nullable<T> = T | null;

/** `T`, `null` or `undefined` — for loosely-typed inputs (query params, optional payload fields). */
export type Maybe<T> = T | null | undefined;

/**
 * Wraps a constructor-injected type that participates in an ESM circular import:
 * `@Inject(forwardRef(() => X)) private readonly x: WrapperType<X>`. Without the wrapper,
 * `emitDecoratorMetadata` references `X` at class-definition time, which is still in its TDZ in
 * ESM and throws `ReferenceError: Cannot access 'X' before initialization`.
 */
export type WrapperType<T> = T;

/**
 * A class constructor producing `T`. `never[]` as the default argument list makes every class
 * assignable (parameters are contravariant) while still allowing `new ctor()`.
 */
export type Constructor<T = object, TArgs extends readonly unknown[] = never[]> = new (
  ...args: TArgs
) => T;

/** Recursively read-only view of `T` (functions, Dates and primitives are left as-is). */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Date
    ? T
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;
