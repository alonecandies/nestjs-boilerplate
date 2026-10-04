import { type GrpcConfig, grpcConfig } from '@app/config';
import {
  callerContextFromCls,
  createOutgoingMetadata,
  type GrpcCircuitBreaker,
  GrpcCircuitBreakers,
  grpcCall,
} from '@app/transport';
import type { Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';

/** Breaker name shared by every identity RPC (one upstream = one circuit). */
export const IDENTITY_UPSTREAM = 'identity';

/**
 * Runs one unary identity RPC the way every gateway call must: outgoing metadata (request id,
 * correlation id and caller from nestjs-cls), the configured deadline (`GRPC_DEADLINE_MS`, also
 * enforced by the channel's service config) and the `identity` circuit breaker. Failures come
 * back as `DomainException`s with the service's codes (e.g. `EMAIL_TAKEN`), so presentation code
 * handles remote and local errors identically.
 */
@Injectable()
export class IdentityGrpcCaller {
  private readonly breaker: GrpcCircuitBreaker;

  constructor(
    @Inject(grpcConfig.KEY) private readonly config: GrpcConfig,
    breakers: GrpcCircuitBreakers,
    @Optional() private readonly cls?: ClsService,
  ) {
    this.breaker = breakers.get(IDENTITY_UPSTREAM);
  }

  call<T>(operation: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    const metadata = createOutgoingMetadata(callerContextFromCls(this.cls));
    return grpcCall(invoke(metadata), {
      timeoutMs: this.config.deadlineMs,
      operation,
      breaker: this.breaker,
    });
  }
}
