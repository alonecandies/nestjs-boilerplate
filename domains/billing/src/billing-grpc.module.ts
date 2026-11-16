import { Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { BILLING_RBAC } from './billing.permissions.js';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingGrpcController } from './presentation/grpc/billing-grpc.controller.js';

/**
 * billing-service: `billing.v1.BillingService` over the core. Host it with
 * `connectGrpcServer(app, [BILLING_GRPC_PACKAGE])` (after every `app.useGlobal*()`).
 */
@Module({
  imports: [BillingCoreModule, RbacModule.forFeature(BILLING_RBAC)],
  controllers: [BillingGrpcController],
})
export class BillingGrpcModule {}
