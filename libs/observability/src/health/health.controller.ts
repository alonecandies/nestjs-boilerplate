import { Public, withTimeout } from '@app/common';
import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Res,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorFunction,
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { FastifyReply } from 'fastify';
import { mapValues } from 'lodash-es';
import { HEALTH_OPTIONS } from '../observability.constants.js';
import type { ResolvedHealthOptions } from './health.types.js';
import type { HealthContributor } from './health-contributor.js';
import { HealthContributorRegistry } from './health-contributor.registry.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keeps `status` (and the data of `up` entries) only — failure details stay in the logs. */
function redactSection(section: HealthIndicatorResult): HealthIndicatorResult;
function redactSection(
  section: Partial<HealthIndicatorResult> | undefined,
): Partial<HealthIndicatorResult> | undefined;
function redactSection(
  section: Partial<HealthIndicatorResult> | undefined,
): Partial<HealthIndicatorResult> | undefined {
  if (section === undefined) return undefined;
  return mapValues(section, (entry) =>
    entry === undefined || entry.status === 'up' ? entry : { status: entry.status },
  );
}

/**
 * Kubernetes-style probes, VERSION_NEUTRAL (`/health/*`, never `/v1/health/*`) and `@Public()`.
 * Both are served on the app's HTTP port — also in gRPC/Kafka-only services (infra contract).
 */
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly registry: HealthContributorRegistry,
    @Inject(HEALTH_OPTIONS) private readonly options: ResolvedHealthOptions,
  ) {}

  /**
   * Liveness: the process and its event loop answer. Deliberately checks NO dependency — a
   * database outage must not make the orchestrator restart every replica — and keeps answering
   * 200 during graceful shutdown (readiness reports that).
   */
  @Get('live')
  @HealthCheck({ noCache: true, swaggerDocumentation: false })
  live(): HealthCheckResult {
    return { status: 'ok', info: {}, error: {}, details: {} };
  }

  /**
   * Readiness: every contributor in parallel, each bounded by `readinessTimeoutMs`. 200 when all are
   * up/degraded, 503 when one is down or the app is draining after SIGTERM (terminus
   * `shutting_down`). The body keeps terminus' shape on 503 too, instead of the generic problem+json
   * the global filter would render.
   */
  @Get('ready')
  @HealthCheck({ noCache: true, swaggerDocumentation: false })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthCheckResult> {
    const checks: HealthIndicatorFunction[] = this.registry.contributors.map(
      (contributor) => () => this.runContributor(contributor),
    );
    try {
      return this.present(await this.health.check(checks));
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return this.present(error.getResponse() as HealthCheckResult);
    }
  }

  /** Never rejects: terminus turns a rejected indicator into a 500 instead of a `down` entry. */
  private async runContributor(contributor: HealthContributor): Promise<HealthIndicatorResult> {
    const { key } = contributor;
    const timeoutMs = this.options.readinessTimeoutMs;
    try {
      return await withTimeout(
        Promise.resolve().then(() => contributor.check()),
        timeoutMs,
        `timed out after ${timeoutMs} ms`,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn(`Readiness check "${key}" failed: ${message}`);
      return this.indicators.check(key).down({ message });
    }
  }

  private present(result: HealthCheckResult): HealthCheckResult {
    if (this.options.exposeDetails) return result;
    return {
      ...result,
      info: redactSection(result.info),
      error: redactSection(result.error),
      details: redactSection(result.details),
    };
  }
}
