import { Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { AI_RBAC } from './ai.permissions.js';
import { AiCoreModule } from './ai-core.module.js';
import { AiPort } from './application/ports/ai.port.js';
import { AiLocalAdapter } from './infrastructure/adapters/local/ai-local.adapter.js';
import { AiGrpcController } from './presentation/grpc/ai-grpc.controller.js';

/**
 * ai-service: `ai.v1.AiService` over the core (the controller sees `AiPort`, bound here to the CQRS
 * buses). Host it with `connectGrpcServer(app, [AI_GRPC_PACKAGE])` (after every `app.useGlobal*()`).
 */
@Module({
  imports: [AiCoreModule, RbacModule.forFeature(AI_RBAC)],
  controllers: [AiGrpcController],
  providers: [{ provide: AiPort, useClass: AiLocalAdapter }],
})
export class AiGrpcModule {}
