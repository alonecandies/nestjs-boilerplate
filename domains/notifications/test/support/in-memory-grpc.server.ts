import { Metadata } from '@grpc/grpc-js';
import { type CustomTransportStrategy, Server, Transport } from '@nestjs/microservices';
import { isObservable, lastValueFrom } from 'rxjs';

/**
 * A gRPC "server" for unit tests: `@GrpcMethod` handlers (generated `...ControllerMethods()`)
 * register on it like on `ServerGrpc`, and `call()` runs a request through the full RPC pipeline
 * (payload pipes, the controller-scoped `DomainToGrpcExceptionFilter`, interceptors) — minus the
 * network and protobuf encoding.
 */
export class InMemoryGrpcServer extends Server implements CustomTransportStrategy {
  constructor() {
    super();
    this.setTransportId(Transport.GRPC);
  }

  listen(callback: () => void): void {
    callback();
  }

  close(): void {
    // Nothing to release.
  }

  on(): void {
    // No server events.
  }

  unwrap<T>(): T {
    throw new Error('InMemoryGrpcServer has no underlying server');
  }

  /** Resolves with the response, or rejects with the `{ code, message, metadata }` the client would get. */
  async call(
    service: string,
    rpc: string,
    request: unknown,
    metadata: Metadata = new Metadata(),
  ): Promise<unknown> {
    const route = `{"rpc":"${rpc}","service":"${service}","streaming":"no_stream"}`;
    const handler = this.getHandlerByPattern(route);
    if (!handler) throw new Error(`No gRPC handler for ${service}/${rpc}`);
    // (request, metadata): the handlers declare @Payload/@Ctx, so no call object is needed.
    const result: unknown = await handler(request, metadata);
    return isObservable(result) ? lastValueFrom(result, { defaultValue: undefined }) : result;
  }
}
