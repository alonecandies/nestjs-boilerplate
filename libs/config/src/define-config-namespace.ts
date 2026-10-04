import { type ConfigFactoryKeyHost, registerAs } from '@nestjs/config';
import type { z } from 'zod';
import { type EnvSource, parseEnv } from './env/parse-env.js';

/**
 * A registered config namespace: callable factory (reads `process.env`) + `KEY` injection token
 * (`@Inject(xConfig.KEY) cfg: XConfig`) + the underlying env schema and a pure `parse(env)` for
 * tests/scripts. Load it with `ConfigModule.forFeature(xConfig)` in the module that injects it.
 */
export type ConfigNamespace<TName extends string, TConfig extends object> = (() => TConfig) &
  ConfigFactoryKeyHost<TConfig> & {
    readonly namespace: TName;
    readonly schema: z.ZodType<TConfig>;
    parse(env?: EnvSource): TConfig;
  };

/** Builds a `registerAs` factory whose value is `parseEnv(namespace, schema)`. */
export function defineConfigNamespace<const TName extends string, TConfig extends object>(
  namespace: TName,
  schema: z.ZodType<TConfig>,
): ConfigNamespace<TName, TConfig> {
  const parse = (env: EnvSource = process.env): TConfig => parseEnv(namespace, schema, env);
  const factory = registerAs(namespace, (): TConfig => parse());
  return Object.assign(factory, { namespace, schema, parse });
}
