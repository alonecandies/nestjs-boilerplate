import {
  type GetUserRequest,
  type GetUsersByIdsRequest,
  IDENTITY_GRPC_PACKAGE,
  type ListUsersRequest,
  type UpdateUserRolesRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '@domain/identity-contracts';
import type { Metadata } from '@grpc/grpc-js';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Ctx, Payload } from '@nestjs/microservices';
import { getPrincipal, PermissionDeniedException } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { createGrpcServerStrategy, GRPC_METADATA_KEYS, GrpcController } from '@platform/transport';
import { ClsModule } from 'nestjs-cls';

/** What the identity stand-in saw: the principal its handler ran as and the assertion bytes. */
export const identityCalls: { principal: unknown; assertion: unknown }[] = [];

@GrpcController()
@UsersServiceControllerMethods()
class IdentityStandInController implements UsersServiceController {
  getUser(@Payload() request: GetUserRequest, @Ctx() metadata?: Metadata): User {
    identityCalls.push({
      principal: getPrincipal(),
      assertion: metadata?.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION)[0],
    });
    const at = new Date('2026-09-01T10:00:00.000Z');
    return {
      id: request.id,
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  getUsersByIds(_request: GetUsersByIdsRequest): UserList {
    throw new PermissionDeniedException('not served by the stand-in');
  }

  listUsers(_request: ListUsersRequest): UserPage {
    throw new PermissionDeniedException('not served by the stand-in');
  }

  updateUserRoles(_request: UpdateUserRolesRequest): User {
    throw new PermissionDeniedException('not served by the stand-in');
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [IdentityStandInController],
})
class IdentityStandInModule {}

/**
 * Starts the stand-in on `127.0.0.1:0`; wrap it in `withBoundGrpcPort` to learn the port the
 * server really bound. Imported by the spec's `vi.hoisted` block, because ai-service reads
 * IDENTITY_GRPC_URL before the spec's own imports run.
 */
export async function startIdentityStandIn(): Promise<INestMicroservice> {
  const identity = await NestFactory.createMicroservice(IdentityStandInModule, {
    ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: '127.0.0.1:0' }), [
      IDENTITY_GRPC_PACKAGE,
    ]),
    logger: false,
  });
  await identity.listen();
  return identity;
}
