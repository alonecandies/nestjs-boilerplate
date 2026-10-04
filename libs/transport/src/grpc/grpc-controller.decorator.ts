import {
  applyDecorators,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { DomainToGrpcExceptionFilter } from './domain-to-grpc-exception.filter.js';
import { GrpcContextInterceptor } from './grpc-context.interceptor.js';

/**
 * Use this instead of `@Controller()` on every gRPC controller. It applies
 * `DomainToGrpcExceptionFilter` and `GrpcContextInterceptor` at controller scope, which is the only
 * reliable way to scope gRPC error handling in a hybrid app:
 * - `app.useGlobalFilters()` with `inheritAppConfig: true` also catches HTTP errors, and the
 *   request then hangs.
 * - `ms.useGlobalFilters()` after `connectMicroservice()` is ignored (listeners are already bound).
 * - `deferInitialization: true` runs lifecycle hooks twice.
 * (nest-distributed §7.3)
 *
 * Combine it with the generated `XServiceControllerMethods()` decorator from `@app/contracts`.
 */
export const GrpcController = (): ClassDecorator =>
  applyDecorators(
    Controller(),
    UseFilters(DomainToGrpcExceptionFilter),
    UseInterceptors(GrpcContextInterceptor),
  );

/**
 * Injects the raw grpc-js call (`ServerUnaryCall` / `ServerWritableStream`), which is handler
 * argument #2. Nest ships no decorator for it. Once a handler uses any param decorator, Nest stops
 * injecting `(request, metadata, call)` by default, so declare `@Ctx() metadata` and
 * `@GrpcServerCall() call` explicitly and keep both optional so the method still satisfies the
 * generated controller interface. Use `call.cancelled` to stop long work after the client's
 * deadline has passed.
 */
export const GrpcServerCall = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): unknown => ctx.getArgByIndex(2),
);
