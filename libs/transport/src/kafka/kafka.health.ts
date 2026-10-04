import { withTimeout } from '@app/common';
import { type KafkaConfig, kafkaConfig } from '@app/config';
import type { HealthContributor } from '@app/observability';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { type Admin, Kafka } from 'kafkajs';
import { createKafkaClientConfig } from './kafka.options.js';

/** Per-check budget; the readiness endpoint applies its own overall timeout on top. */
const CHECK_TIMEOUT_MS = 2_500;
/** Collapses probe storms (kubelet + load balancer + humans) into one broker round trip. */
const RESULT_CACHE_MS = 2_000;
/** Upper bound for releasing the admin connection on shutdown (never block the drain on Kafka). */
const SHUTDOWN_DISCONNECT_TIMEOUT_MS = 2_000;

/**
 * Readiness contributor for Kafka (`key: 'kafka'`): `describeCluster` through a dedicated admin
 * client, created on the first check and reused (one metadata request per check instead of a new
 * connection each time). The client retries NOTHING — neither admin requests nor the broker
 * connect — so a broker outage reports `down` quickly and no background reconnect loop outlives
 * the check (or delays shutdown). A failed admin client is discarded and rebuilt on the next check.
 *
 * Register it with `ObservabilityModule.forRoot({ healthContributors: [KafkaHealthIndicator] })`.
 * It needs the `kafka` config namespace, which `KafkaProducerModule` exports globally.
 */
@Injectable()
export class KafkaHealthIndicator implements HealthContributor, OnApplicationShutdown {
  readonly key = 'kafka';
  private readonly logger = new Logger(KafkaHealthIndicator.name);
  private admin: Promise<Admin> | undefined;

  constructor(
    @Inject(kafkaConfig.KEY) private readonly cfg: KafkaConfig,
    private readonly health: HealthIndicatorService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async () => {
        try {
          const admin = await this.connectedAdmin();
          const cluster = await admin.describeCluster();
          // Terminus adds `responseTime` itself.
          return { brokers: cluster.brokers.length, controller: cluster.controller };
        } catch (error) {
          this.discardAdmin();
          throw error;
        }
      })
      .withTimeout(CHECK_TIMEOUT_MS)
      .cacheFor(RESULT_CACHE_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    const admin = this.admin;
    this.admin = undefined;
    if (admin === undefined) return;
    try {
      await withTimeout(
        admin.then((connected) => connected.disconnect()),
        SHUTDOWN_DISCONNECT_TIMEOUT_MS,
      );
    } catch {
      // The admin never connected, the broker is gone, or it did not answer in time: nothing
      // worth waiting for — the process is exiting anyway.
    }
  }

  /** Overridable in tests. */
  protected createAdmin(): Admin {
    // `admin({ retry })` only covers admin requests; `admin.connect()` goes through the CLUSTER
    // retrier built from the client-level `retry` (kafkajs default: several attempts with
    // exponential backoff up to `maxRetryTime`). Hence `retries: 0` on the client too — safe here
    // (unlike for producers) because this client never produces.
    const base = createKafkaClientConfig(this.cfg, `${this.cfg.clientId}-health`);
    const kafka = new Kafka({ ...base, retry: { ...base.retry, retries: 0 } });
    return kafka.admin({ retry: { retries: 0 } });
  }

  private connectedAdmin(): Promise<Admin> {
    this.admin ??= (async (): Promise<Admin> => {
      const admin = this.createAdmin();
      await admin.connect();
      return admin;
    })();
    return this.admin;
  }

  private discardAdmin(): void {
    const admin = this.admin;
    this.admin = undefined;
    admin
      ?.then((connected) => connected.disconnect())
      .catch((error: unknown) =>
        this.logger.debug(`Discarding Kafka admin client: ${String(error)}`),
      );
  }
}
