import type { UsageRecord } from '../../domain/ai.types.js';

/**
 * The usage log (implemented by `DrizzleUsageRepository`, under RLS): one row per model call,
 * success or failure, written as the caller in the call's unit of work. Append-only: the runtime
 * role holds no UPDATE or DELETE on it.
 */
export abstract class UsageRepository {
  /** Appends one call's usage for the principal. */
  abstract record(entry: UsageRecord): Promise<void>;
}
