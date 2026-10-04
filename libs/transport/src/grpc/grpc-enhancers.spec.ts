import { DomainValidationException, EntityNotFoundException } from '@app/common';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  INTERCEPTORS_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { GrpcStatus } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainToGrpcExceptionFilter } from './domain-to-grpc-exception.filter.js';
import { GrpcContextInterceptor } from './grpc-context.interceptor.js';
import { GrpcController } from './grpc-controller.decorator.js';
import type { GrpcErrorResponse } from './grpc-status.mapping.js';
import { ZodRpcValidationPipe } from './zod-rpc-validation.pipe.js';

const grpcHost = (path = '/identity.v1.UsersService/GetUser'): ArgumentsHost =>
  ({
    getType: () => 'rpc',
    getArgByIndex: (index: number) => (index === 2 ? { getPath: () => path } : undefined),
  }) as unknown as ArgumentsHost;

async function rejectionOf(
  filter: DomainToGrpcExceptionFilter,
  error: unknown,
): Promise<GrpcErrorResponse> {
  return firstValueFrom(filter.catch(error, grpcHost())).then(
    () => {
      throw new Error('expected the filter to error');
    },
    (response: unknown) => response as GrpcErrorResponse,
  );
}

describe('DomainToGrpcExceptionFilter', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('emits the mapped gRPC error (status, message, trailers) as an error notification', async () => {
    const response = await rejectionOf(
      new DomainToGrpcExceptionFilter(),
      new EntityNotFoundException('User', 'u1'),
    );
    expect(response.code).toBe(GrpcStatus.NOT_FOUND);
    expect(response.message).toBe('User "u1" was not found');
    expect(response.metadata?.get('x-error-code')).toEqual(['NOT_FOUND']);
  });

  it('hides unexpected errors unless EXCEPTIONS_FILTER_OPTIONS.exposeInternal', async () => {
    const error = new Error('secret');
    await expect(rejectionOf(new DomainToGrpcExceptionFilter(), error)).resolves.toEqual({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    });
    await expect(
      rejectionOf(new DomainToGrpcExceptionFilter({ exposeInternal: true }), error),
    ).resolves.toMatchObject({ message: 'secret' });
  });
});

describe('ZodRpcValidationPipe', () => {
  const pipe = new ZodRpcValidationPipe(
    z.object({ id: z.uuid(), limit: z.number().int().default(20) }),
  );

  it('returns the parsed payload (defaults applied)', () => {
    expect(pipe.transform({ id: '0199d1c6-5d7e-7a4e-8c3b-2f1e0d9c8b7a' })).toEqual({
      id: '0199d1c6-5d7e-7a4e-8c3b-2f1e0d9c8b7a',
      limit: 20,
    });
  });

  it('throws DomainValidationException with issues', () => {
    let error: unknown;
    try {
      pipe.transform({ id: 'nope', limit: 1.5 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainValidationException);
    expect((error as DomainValidationException).message).toBe('Invalid request payload');
    expect((error as DomainValidationException).issues.map((issue) => issue.path)).toEqual([
      'id',
      'limit',
    ]);
  });
});

describe('@GrpcController()', () => {
  @GrpcController()
  class DecoratedController {}

  it('is a Nest controller with the gRPC filter and context interceptor at controller scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DecoratedController)).toBe('/');
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, DecoratedController)).toEqual([
      DomainToGrpcExceptionFilter,
    ]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, DecoratedController)).toEqual([
      GrpcContextInterceptor,
    ]);
  });
});
