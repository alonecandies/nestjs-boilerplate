import { getHeaderValue, type RequestLike, timingSafeEqualStr } from '@app/common';
import { type ObservabilityConfig, observabilityConfig } from '@app/config';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

const BEARER_PREFIX = /^Bearer\s+/i;

/**
 * Controller-scoped (HTTP only) guard of `GET /metrics`: when `METRICS_BEARER_TOKEN` is set, the
 * scrape must send `Authorization: Bearer <token>` (compared in constant time). A missing or wrong
 * token answers 404 — the same as a disabled endpoint, so the route's existence isn't revealed.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(@Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.metricsBearerToken;
    if (expected === undefined) return true;
    const header = getHeaderValue(
      context.switchToHttp().getRequest<RequestLike>().headers,
      'authorization',
    );
    if (header === undefined || !BEARER_PREFIX.test(header)) throw new NotFoundException();
    if (!timingSafeEqualStr(header.replace(BEARER_PREFIX, '').trim(), expected)) {
      throw new NotFoundException();
    }
    return true;
  }
}
