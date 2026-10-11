import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingGrpcController } from './presentation/grpc/billing-grpc.controller.js';

/**
 * billing-service: `billing.v1.BillingService` over the core. Host it with
 * `connectGrpcServer(app, ['billing'])` (after every `app.useGlobal*()`).
 */
@Module({
  imports: [BillingCoreModule],
  controllers: [BillingGrpcController],
})
export class BillingGrpcModule {}
