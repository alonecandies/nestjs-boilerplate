import {
  Counter,
  type CounterConfiguration,
  Gauge,
  type GaugeConfiguration,
  Histogram,
  type HistogramConfiguration,
  register,
} from 'prom-client';

/**
 * Process-wide metrics created outside DI (functions such as `grpcCall`, interceptors built with
 * `new`, pool wrappers). prom-client's default registry is global and throws on a second metric with
 * the same name, so these return the one already registered (several Nest apps in one test process,
 * repeated module registrations). `MetricsListener` serves the same registry.
 */
export function getOrCreateCounter<T extends string>(config: CounterConfiguration<T>): Counter<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Counter(config);
  if (existing instanceof Counter) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}

export function getOrCreateGauge<T extends string>(config: GaugeConfiguration<T>): Gauge<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Gauge(config);
  if (existing instanceof Gauge) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}

export function getOrCreateHistogram<T extends string>(
  config: HistogramConfiguration<T>,
): Histogram<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Histogram(config);
  if (existing instanceof Histogram) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}
