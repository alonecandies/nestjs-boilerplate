import { Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { IDENTITY_RBAC } from './identity.permissions.js';
import { IdentityCoreModule } from './identity-core.module.js';
import { AuthGrpcController } from './presentation/grpc/auth-grpc.controller.js';
import { UsersGrpcController } from './presentation/grpc/users-grpc.controller.js';

/**
 * identity-service: exposes `identity.v1.AuthService` + `identity.v1.UsersService` over gRPC
 * (`connectGrpcServer(app, [IDENTITY_GRPC_PACKAGE])` in main.ts). No HTTP API.
 */
@Module({
  imports: [IdentityCoreModule, RbacModule.forFeature(IDENTITY_RBAC)],
  controllers: [AuthGrpcController, UsersGrpcController],
})
export class IdentityGrpcModule {}
