import { z } from 'zod';

/** Shape of `process.env` (also what tests pass instead of it). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Thrown when a namespace's environment is invalid. The message lists every offending variable
 * BY ITS ENV NAME (schemas are keyed by env var names), so the boot log says exactly what to fix.
 * Values are never echoed — env vars hold secrets.
 */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  constructor(
    readonly namespace: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(`Invalid environment for "${namespace}":\n${z.prettifyError({ issues: [...issues] })}`);
  }
}

/**
 * Validates `env` (default `process.env`) against a namespace schema and returns its transformed,
 * camelCased output. Called by the `registerAs` factories at DI time — i.e. only for the
 * namespaces an app actually loads — and usable directly from scripts (migrations, cluster
 * primary) that run without Nest.
 */
export function parseEnv<TSchema extends z.ZodType>(
  namespace: string,
  schema: TSchema,
  env: EnvSource = process.env,
): z.output<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) throw new EnvValidationError(namespace, result.error.issues);
  return result.data;
}
