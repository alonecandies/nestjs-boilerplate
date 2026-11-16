import cluster from 'node:cluster';
import { Inject, Injectable, Logger, type OnApplicationShutdown, Optional } from '@nestjs/common';
import {
  type AppConfig,
  appConfig,
  type ObservabilityConfig,
  observabilityConfig,
} from '@platform/config';
import { register } from 'prom-client';
import { METRICS_PATH } from './metrics.constants.js';
import {
  METRICS_NOT_FOUND,
  type MetricsScrape,
  type MetricsServer,
  scrapeMetrics,
  startMetricsServer,
} from './metrics-server.js';

/**
 * `/metrics` of one Nest app on its own listener (`METRICS_PORT`, default 9464), never on the API
 * port. Opened by `listenMetrics(app)` (`@platform/bootstrap`) in `main.ts`; closed on application
 * shutdown, after the API stopped. Under `runClustered()` workers never open it: the primary serves
 * the cluster-wide aggregate on the same port (`startClusterPrimaryMetrics`).
 */
@Injectable()
export class MetricsListener implements OnApplicationShutdown {
  private readonly logger = new Logger(MetricsListener.name);
  private server: MetricsServer | undefined;

  constructor(
    @Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig,
    @Optional() @Inject(appConfig.KEY) private readonly app?: AppConfig,
  ) {}

  /**
   * Opens the listener and resolves its URL; `undefined` when `METRICS_ENABLED=false` or in a
   * cluster worker. Throws when `METRICS_PORT` equals `PORT` or the port is taken.
   */
  async start(): Promise<string | undefined> {
    if (!this.config.metricsEnabled || cluster.isWorker) return undefined;
    if (this.server !== undefined) return this.server.url;
    const port = this.config.metricsPort;
    if (port !== 0 && this.app !== undefined && port === this.app.port) {
      throw new Error(
        `METRICS_PORT (${port}) must differ from PORT (${this.app.port}): /metrics has its own listener`,
      );
    }
    this.server = await startMetricsServer({
      port,
      host: this.app?.host ?? '0.0.0.0',
      bearerToken: this.config.metricsBearerToken,
      collect: () => register.metrics(),
    });
    this.logger.log(`Metrics listening on ${this.server.url}${METRICS_PATH}`);
    return this.server.url;
  }

  /** The listener's answer, in-process (e2e specs that do not bind ports). */
  scrape(authorization?: string): Promise<MetricsScrape> {
    if (!this.config.metricsEnabled) return Promise.resolve(METRICS_NOT_FOUND);
    return scrapeMetrics(
      { bearerToken: this.config.metricsBearerToken, collect: () => register.metrics() },
      { method: 'GET', url: METRICS_PATH, authorization },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.close();
  }
}
