import { DomainException, type DomainExceptionOptions } from '@app/common';
import type { HttpStatus } from '@nestjs/common';
import type { GrpcStatus } from '@nestjs/microservices';

/**
 * An upstream gRPC status that has no dedicated `DomainException` subclass in `@app/common`,
 * for example `RESOURCE_EXHAUSTED` (429) or `UNIMPLEMENTED` (501). It keeps the original gRPC
 * status, so a service that relays it answers with the same code.
 */
export class RpcStatusException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus;

  constructor(
    readonly grpcStatus: GrpcStatus,
    httpStatus: HttpStatus,
    code: string,
    message: string,
    options?: DomainExceptionOptions,
  ) {
    super(message, options);
    this.httpStatus = httpStatus;
    this.code = options?.code ?? code;
  }
}
