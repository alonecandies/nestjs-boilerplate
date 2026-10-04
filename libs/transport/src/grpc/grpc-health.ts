import { HealthImplementation, type ServingStatus } from 'grpc-health-check';
import { uniq } from 'lodash-es';

export type { ServingStatus } from 'grpc-health-check';

/** The server type `HealthImplementation.addToServer` expects (structural, grpc-js compatible). */
export type HealthServer = Parameters<HealthImplementation['addToServer']>[0];

/**
 * The `grpc.health.v1.Health` service of one gRPC server. It reports the overall status (`''`)
 * and the status of each fully-qualified service (`identity.v1.UsersService`), and supports both
 * `Check` and `Watch`. Kubernetes gRPC probes, `grpc_health_probe` and load balancers read it.
 *
 * `HealthReportingGrpcServer` switches it to `SERVING` once every service is registered, and to
 * `NOT_SERVING` when shutdown starts, before in-flight calls drain.
 */
export class GrpcHealthService {
  readonly services: readonly string[];
  private readonly implementation: HealthImplementation;
  private current: ServingStatus;

  constructor(services: readonly string[], initialStatus: ServingStatus = 'NOT_SERVING') {
    this.services = uniq(services);
    this.current = initialStatus;
    this.implementation = new HealthImplementation(
      Object.fromEntries(['', ...this.services].map((name) => [name, initialStatus])),
    );
  }

  /** The status currently reported for the whole server. */
  get status(): ServingStatus {
    return this.current;
  }

  /** Sets the status of the server and of every service it hosts. */
  setStatus(status: ServingStatus): void {
    this.current = status;
    for (const name of ['', ...this.services]) this.implementation.setStatus(name, status);
  }

  addToServer(server: HealthServer): void {
    this.implementation.addToServer(server);
  }
}
