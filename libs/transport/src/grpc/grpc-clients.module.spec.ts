import { AppConfigModule, type GrpcConfig, grpcConfig } from '@app/config';
import { GRPC_PACKAGES } from '@app/contracts';
import { type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { GrpcClientsModule } from './grpc-clients.module.js';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    GrpcClientsModule.register(['identity', 'billing', 'identity'], {
      breaker: { resetTimeout: 1_000 },
    }),
  ],
})
class TestRootModule {}

describe('GrpcClientsModule.register (DI wiring, no server)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await NestFactory.createApplicationContext(TestRootModule, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers one lazily-connecting ClientGrpc per package under its client token', () => {
    const identity = app.get<ClientGrpcProxy>(GRPC_PACKAGES.identity.clientToken);
    const billing = app.get<ClientGrpcProxy>(GRPC_PACKAGES.billing.clientToken);
    expect(identity).toBeInstanceOf(ClientGrpcProxy);
    expect(billing).toBeInstanceOf(ClientGrpcProxy);
    expect(identity).not.toBe(billing);
    expect(() => app.get(GRPC_PACKAGES.notifications.clientToken)).toThrow();
    // Service stubs resolve from the proto without any network traffic.
    expect(typeof identity.getService<{ getUser: unknown }>('UsersService').getUser).toBe(
      'function',
    );
  });

  it('exports the breaker registry and the grpc config namespace', () => {
    expect(app.get(GrpcCircuitBreakers)).toBeInstanceOf(GrpcCircuitBreakers);
    expect(app.get<GrpcConfig>(grpcConfig.KEY).deadlineMs).toBe(grpcConfig.parse().deadlineMs);
  });
});
