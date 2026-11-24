import { generateKeyPairSync } from 'node:crypto';
import { type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigModule, type GrpcConfig, grpcConfig } from '@platform/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ECHO_GRPC_PACKAGE,
  FIXTURE_GRPC_PACKAGE,
} from '../../test/fixtures/fixture.grpc-package.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { GrpcClientsModule } from './grpc-clients.module.js';
import {
  applyPrincipalAssertionConfig,
  configurePrincipalAssertions,
  principalAssertionSettings,
} from './grpc-principal-assertion.js';

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

const pemsOf = (namedCurve: 'P-256' | 'P-384'): { privatePem: string; publicPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

describe('GrpcClientsModule: principal assertion settings from the injected grpc config', () => {
  const p256 = pemsOf('P-256');
  const p384 = pemsOf('P-384');
  let moduleRef: TestingModule | undefined;

  /** Closes the last module; `close()` rethrows a failed `init()`, which the test already saw. */
  async function closeModule(): Promise<void> {
    await moduleRef?.close().catch(() => undefined);
    moduleRef = undefined;
  }

  afterEach(async () => {
    await closeModule();
    configurePrincipalAssertions(undefined);
    applyPrincipalAssertionConfig(undefined);
  });

  /** A module whose `grpc` namespace holds `principalAssertion`, as if validated at boot. */
  async function compile(
    principalAssertion: GrpcConfig['principalAssertion'],
  ): Promise<TestingModule> {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        GrpcClientsModule.register({ spec: FIXTURE_GRPC_PACKAGE, url: '127.0.0.1:1' }),
      ],
    })
      .overrideProvider(grpcConfig.KEY)
      .useValue({ ...grpcConfig.parse({}), principalAssertion })
      .compile();
    return moduleRef;
  }

  it('builds the settings from the injected config at init, not from the environment', async () => {
    await (
      await compile({
        mode: 'warn',
        ttlSec: 300,
        signingKey: { keyId: 'edge-1', pem: p256.privatePem },
        publicKeys: [{ keyId: 'edge-1', pem: p256.publicPem }],
      })
    ).init();

    const settings = principalAssertionSettings();
    expect(settings.mode).toBe('warn');
    expect(settings.signingKey?.keyId).toBe('edge-1');
    expect(settings.signingKey?.ttlSec).toBe(300);
    expect([...settings.publicKeys.keys()]).toEqual(['edge-1']);
  });

  it('rejects at init a signing key that is not a P-256 key, naming the variable, not the key', async () => {
    const init = (
      await compile({
        mode: 'off',
        ttlSec: 120,
        signingKey: { keyId: 'edge-1', pem: p384.privatePem },
        publicKeys: [],
      })
    ).init();

    await expect(init).rejects.toThrow(/GRPC_PRINCIPAL_SIGNING_KEY.*"edge-1"/);
    await expect(init).rejects.not.toThrow(/BEGIN/);
  });

  it('rejects at init a public key that is not a P-256 key, or a PEM that is no key at all', async () => {
    await expect(
      (
        await compile({
          mode: 'warn',
          ttlSec: 120,
          signingKey: undefined,
          publicKeys: [{ keyId: 'next', pem: p384.publicPem }],
        })
      ).init(),
    ).rejects.toThrow(/GRPC_PRINCIPAL_PUBLIC_KEYS.*"next"/);
    await closeModule();

    await expect(
      (
        await compile({
          mode: 'off',
          ttlSec: 120,
          signingKey: { keyId: 'edge-1', pem: 'not a pem' },
          publicKeys: [],
        })
      ).init(),
    ).rejects.toThrow(/GRPC_PRINCIPAL_SIGNING_KEY.*"edge-1"/);
  });

  it('leaves configurePrincipalAssertions in charge while it is set (tests)', async () => {
    const replaced = { mode: 'enforce', publicKeys: new Map() } as const;
    configurePrincipalAssertions(replaced);
    await (
      await compile({ mode: 'warn', ttlSec: 120, signingKey: undefined, publicKeys: [] })
    ).init();

    expect(principalAssertionSettings()).toBe(replaced);
    configurePrincipalAssertions(undefined);
    expect(principalAssertionSettings().mode).toBe('warn');
  });
});
