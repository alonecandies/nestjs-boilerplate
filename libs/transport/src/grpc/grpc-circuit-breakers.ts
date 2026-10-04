import { isDomainException } from '@app/common';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { GrpcStatus } from '@nestjs/microservices';
import CircuitBreaker from 'opossum';
import { GRPC_CIRCUIT_BREAKER_OPTIONS } from './grpc.constants.js';
import { isGrpcServiceError } from './grpc-status.mapping.js';

/** The unit of work a breaker runs: one upstream call. */
export type GrpcBreakerTask = () => Promise<unknown>;

/** One opossum breaker per upstream. It accepts any task, so all methods of a service share it. */
export type GrpcCircuitBreaker = CircuitBreaker<[GrpcBreakerTask], unknown>;

export type GrpcCircuitBreakerOptions = CircuitBreaker.Options<[GrpcBreakerTask]>;

/**
 * Statuses that report a problem with the request, not with the upstream's health. They must
 * not open the circuit, or one client sending bad ids could cut everyone off from a healthy
 * service. `RESOURCE_EXHAUSTED` is deliberately absent: backing off an overloaded upstream is
 * the point of a breaker.
 */
const CALLER_ERROR_STATUSES: ReadonlySet<number> = new Set([
  GrpcStatus.INVALID_ARGUMENT,
  GrpcStatus.NOT_FOUND,
  GrpcStatus.ALREADY_EXISTS,
  GrpcStatus.PERMISSION_DENIED,
  GrpcStatus.UNAUTHENTICATED,
  GrpcStatus.FAILED_PRECONDITION,
  GrpcStatus.OUT_OF_RANGE,
  GrpcStatus.ABORTED,
]);

/**
 * opossum `errorFilter`: `true` means "don't count this as a failure". It inspects the RAW grpc-js
 * error, which is why `grpcCall` maps errors only after the breaker has seen them. Client-side
 * `DomainException`s (4xx) are treated the same way.
 */
export function isCallerError(error: unknown): boolean {
  if (isGrpcServiceError(error)) return CALLER_ERROR_STATUSES.has(error.code);
  return isDomainException(error) && error.httpStatus < HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Defaults tuned for request/response gRPC:
 * - `timeout: false`: the deadline comes from the gRPC service config and the rxjs timeout,
 *   which also cancel the call. opossum's timeout would only reject and leave the call running.
 * - The circuit opens at 50 % failures once there are ≥ 10 calls in a 10 s window, and probes
 *   again (half-open) after 5 s.
 * - `capacity` is a bulkhead: at most 1000 concurrent calls per upstream per process.
 * - `rollingPercentilesEnabled: false`: latency percentiles sort per-bucket arrays on the hot path,
 *   and Prometheus histograms already cover latency.
 */
export const DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS: Readonly<GrpcCircuitBreakerOptions> = {
  timeout: false,
  errorThresholdPercentage: 50,
  volumeThreshold: 10,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  resetTimeout: 5_000,
  capacity: 1_000,
  rollingPercentilesEnabled: false,
  errorFilter: isCallerError,
};

/**
 * Registry of circuit breakers, one per upstream name (e.g. `'identity'`), created lazily and
 * shared by every adapter that calls that upstream. Use it through `grpcCall(..., { breaker })`.
 * State changes are logged. All breakers shut down (timers cleared) on application shutdown.
 */
@Injectable()
export class GrpcCircuitBreakers implements OnApplicationShutdown {
  private readonly logger = new Logger(GrpcCircuitBreakers.name);
  private readonly breakers = new Map<string, GrpcCircuitBreaker>();
  private readonly options: GrpcCircuitBreakerOptions;

  constructor(
    @Optional()
    @Inject(GRPC_CIRCUIT_BREAKER_OPTIONS)
    overrides?: Partial<GrpcCircuitBreakerOptions>,
  ) {
    this.options = { ...DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS, ...overrides };
  }

  /** The breaker for upstream `name`, created on first use. */
  get(name: string): GrpcCircuitBreaker {
    const existing = this.breakers.get(name);
    if (existing) return existing;
    const breaker: GrpcCircuitBreaker = new CircuitBreaker<[GrpcBreakerTask], unknown>(
      (task) => task(),
      { ...this.options, name },
    );
    breaker.on('open', () => this.logger.warn(`Circuit "${name}" OPEN: failing fast`));
    breaker.on('halfOpen', () => this.logger.log(`Circuit "${name}" HALF-OPEN: probing upstream`));
    breaker.on('close', () => this.logger.log(`Circuit "${name}" CLOSED: upstream recovered`));
    this.breakers.set(name, breaker);
    return breaker;
  }

  /** State of every breaker created so far (diagnostics / debug endpoints). */
  states(): Record<string, 'open' | 'half-open' | 'closed'> {
    return Object.fromEntries(
      [...this.breakers].map(([name, breaker]) => [
        name,
        breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      ]),
    );
  }

  onApplicationShutdown(): void {
    for (const breaker of this.breakers.values()) breaker.shutdown();
    this.breakers.clear();
  }
}
