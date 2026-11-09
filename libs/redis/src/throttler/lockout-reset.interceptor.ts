import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import { concatMap, type Observable } from 'rxjs';
import { takeLockoutAttempts } from './lockout.js';
import { THROTTLER } from './throttle.constants.js';

interface ResettableStorage extends ThrottlerStorage {
  reset(key: string, throttlerName: string): Promise<void>;
}

const canReset = (storage: ThrottlerStorage): storage is ResettableStorage =>
  typeof Reflect.get(storage, 'reset') === 'function';

function requestOf(context: ExecutionContext): object | undefined {
  const type = getContextType(context);
  if (type === 'http') return context.switchToHttp().getRequest<object>();
  if (type === 'graphql') {
    const gql = context.getArgByIndex<{ req?: object } | undefined>(2);
    return gql?.req;
  }
  return undefined;
}

/**
 * A credential attempt counts toward the account lockout BEFORE the handler runs
 * (`AppThrottlerGuard`); this interceptor clears the count once the handler succeeded. Failed
 * logins never get here (REST fails in `LocalAuthGuard`, GraphQL throws), so the counter is
 * "attempts since the last success". A failed reset never fails the request.
 */
@Injectable()
export class LockoutResetInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LockoutResetInterceptor.name);

  constructor(@InjectThrottlerStorage() private readonly storage: ThrottlerStorage) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = requestOf(context);
    const keys = request === undefined ? undefined : takeLockoutAttempts(request);
    const storage = this.storage;
    if (keys === undefined || !canReset(storage)) return next.handle();
    return next.handle().pipe(
      concatMap(async (value: unknown) => {
        try {
          await Promise.all(keys.map((key) => storage.reset(key, THROTTLER.LOCKOUT)));
        } catch (error) {
          this.logger.warn(
            `lockout reset skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return value;
      }),
    );
  }
}
