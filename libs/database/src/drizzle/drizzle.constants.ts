/**
 * Injection token of the application's Drizzle handle (`DrizzleDB<TSchema>`).
 * A symbol (not a class) because the handle's type is a structural alias with no runtime value —
 * inject it with `@InjectDrizzle()`.
 */
export const DRIZZLE = Symbol('DRIZZLE');

/** Injection token of the options passed to `DatabaseModule.forRootAsync()`. */
export const DATABASE_MODULE_OPTIONS = Symbol('DATABASE_MODULE_OPTIONS');
