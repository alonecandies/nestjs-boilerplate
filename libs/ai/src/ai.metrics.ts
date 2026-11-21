import { Injectable } from '@nestjs/common';
import { getOrCreateCounter, getOrCreateHistogram } from '@platform/observability';
import type { AiUsage } from './ai.types.js';

export const AI_REQUESTS_TOTAL = 'ai_requests_total';
export const AI_TOKENS_TOTAL = 'ai_tokens_total';
export const AI_REQUEST_DURATION_SECONDS = 'ai_request_duration_seconds';

/** How a call ended: `aborted` = the caller cancelled (client gone), `timeout` = our deadline. */
export type AiCallOutcome = 'success' | 'error' | 'timeout' | 'aborted';

const DURATION_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];

/**
 * Prometheus metrics of every model call, on the process-wide registry (`MetricsListener` serves
 * it). The `model` label is the requested model, bounded by the allowlist. Tokens count whatever
 * the outcome: a failed call's are those of its model calls that completed (`aiUsageOf`).
 */
@Injectable()
export class AiMetrics {
  readonly requests = getOrCreateCounter({
    name: AI_REQUESTS_TOTAL,
    help: 'AI model calls by requested model and outcome',
    labelNames: ['model', 'outcome'],
  });
  readonly tokens = getOrCreateCounter({
    name: AI_TOKENS_TOTAL,
    help: 'AI tokens used by requested model and kind (input or output)',
    labelNames: ['model', 'kind'],
  });
  readonly duration = getOrCreateHistogram({
    name: AI_REQUEST_DURATION_SECONDS,
    help: 'AI model call duration (whole stream for streaming calls)',
    labelNames: ['model'],
    buckets: DURATION_BUCKETS,
  });

  record(model: string, outcome: AiCallOutcome, latencyMs: number, usage?: AiUsage): void {
    this.requests.inc({ model, outcome });
    this.duration.observe({ model }, latencyMs / 1_000);
    if (usage !== undefined) this.countTokens(model, usage);
  }

  /** Adds tokens alone: a failed call's model call whose usage arrived after it was recorded. */
  countTokens(model: string, usage: AiUsage): void {
    if (usage.inputTokens > 0) this.tokens.inc({ model, kind: 'input' }, usage.inputTokens);
    if (usage.outputTokens > 0) this.tokens.inc({ model, kind: 'output' }, usage.outputTokens);
  }
}
