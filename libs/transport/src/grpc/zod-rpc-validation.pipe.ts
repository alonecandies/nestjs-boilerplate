import { DomainValidationException } from '@app/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates (and parses) a gRPC payload with zod. ts-proto request types are interfaces, so
 * `design:paramtypes` is `Object` and class-validator's `ValidationPipe` would silently skip them
 * (nest-distributed §3.4).
 *
 * On failure it throws `DomainValidationException`. `DomainToGrpcExceptionFilter` maps that to
 * `INVALID_ARGUMENT` and sends the issues as trailers, so the gateway re-raises the same 422
 * with the same `errors[]`.
 *
 * Bind it to the payload only, with `@Payload(new ZodRpcValidationPipe(schema))`. A method-level
 * `@UsePipes` would also run it on the `Metadata` and call arguments.
 * Async refinements are not supported (the pipe parses synchronously, which keeps the hot path cheap).
 */
export class ZodRpcValidationPipe<TSchema extends z.ZodType>
  implements PipeTransform<unknown, z.output<TSchema>>
{
  constructor(
    private readonly schema: TSchema,
    private readonly message = 'Invalid request payload',
  ) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw DomainValidationException.fromIssues(result.error.issues, this.message);
  }
}
