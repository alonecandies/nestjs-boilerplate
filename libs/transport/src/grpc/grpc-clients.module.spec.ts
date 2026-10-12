import { type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { AppConfigModule, type GrpcConfig, grpcConfig } from '@platform/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ECHO_GRPC_PACKAGE,
  FIXTURE_GRPC_PACKAGE,
} from '../../test/fixtures/fixture.grpc-package.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { GrpcClientsModule } from './grpc-clients.module.js';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    GrpcClientsModule.register(
      { spec: FIXTURE_GRPC_PACKAGE, url: '127.0.0.1:1' },
      { breaker: { resetTimeout: 1_000 } },
    ),
    GrpcClientsModule.register({ spec: ECHO_GRPC_PACKAGE, url: '127.0.0.1:2' }),
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

  it('registers one lazily-connecting ClientGrpc per registration under its client token', () => {
    const fixture = app.get<ClientGrpcProxy>(FIXTURE_GRPC_PACKAGE.clientToken);
    const echo = app.get<ClientGrpcProxy>(ECHO_GRPC_PACKAGE.clientToken);
    expect(fixture).toBeInstanceOf(ClientGrpcProxy);
    expect(echo).toBeInstanceOf(ClientGrpcProxy);
    expect(fixture).not.toBe(echo);
    expect(() => app.get('UNREGISTERED_GRPC_CLIENT')).toThrow();
    // Service stubs resolve from each package's own proto root without any network traffic.
    expect(typeof fixture.getService<{ getUser: unknown }>('UsersService').getUser).toBe(
      'function',
    );
    expect(typeof echo.getService<{ echo: unknown }>('EchoService').echo).toBe('function');
  });

  it('exports the breaker registry and the grpc config namespace', () => {
    expect(app.get(GrpcCircuitBreakers)).toBeInstanceOf(GrpcCircuitBreakers);
    expect(app.get<GrpcConfig>(grpcConfig.KEY).deadlineMs).toBe(grpcConfig.parse().deadlineMs);
  });
});
