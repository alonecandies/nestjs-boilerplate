import { generateKeyPairSync } from 'node:crypto';
import type { ClientGrpc } from '@nestjs/microservices';
import { grpcConfig } from '@platform/config';
import type { GrpcCircuitBreakers } from '@platform/transport';
import { describe, expect, it, vi } from 'vitest';
import { AiGrpcAdapter } from './ai-grpc.adapter.js';
import { aiGrpcClientConfig } from './ai-grpc-client.config.js';

/** The gateway's signing key, as `GRPC_PRINCIPAL_SIGNING_KEY` (base64 of a P-256 PEM) and its id. */
const SIGNING_KEY = {
  GRPC_PRINCIPAL_SIGNING_KEY: Buffer.from(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  ).toString('base64'),
  GRPC_PRINCIPAL_SIGNING_KEY_ID: 'edge-1',
};

/** The adapter as `AiApiModule.forRemote()` builds it, over the given env. */
function adapter(env: Record<string, string>): AiGrpcAdapter {
  const client = { getService: vi.fn(() => ({})) } as unknown as ClientGrpc;
  return new AiGrpcAdapter(
    client,
    grpcConfig.parse(env),
    aiGrpcClientConfig.parse(env),
    {} as GrpcCircuitBreakers,
  );
}

describe('AiGrpcAdapter.onModuleInit: a signed assertion must outlive a chat turn', () => {
  it('refuses to start when the assertion TTL minus the reuse window is below the chat deadline, naming both', () => {
    const init = () =>
      adapter({ ...SIGNING_KEY, GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '60' }).onModuleInit();

    expect(init).toThrow(/GRPC_PRINCIPAL_ASSERTION_TTL_SEC/);
    expect(init).toThrow(/AI_GRPC_CHAT_DEADLINE_MS/);
  });

  it('starts with the same TTL when no signing key is configured: nothing is signed', () => {
    expect(() => adapter({ GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '60' }).onModuleInit()).not.toThrow();
  });

  it('starts with the defaults (120 s TTL, 70 s chat deadline) and a signing key', () => {
    expect(() => adapter(SIGNING_KEY).onModuleInit()).not.toThrow();
  });

  it('counts the 5 s reuse window: a 75 s TTL covers a 70 s turn, 74 s does not', () => {
    expect(() =>
      adapter({ ...SIGNING_KEY, GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '75' }).onModuleInit(),
    ).not.toThrow();
    expect(() =>
      adapter({ ...SIGNING_KEY, GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '74' }).onModuleInit(),
    ).toThrow(/AI_GRPC_CHAT_DEADLINE_MS/);
  });

  it('measures against the configured chat deadline', () => {
    expect(() =>
      adapter({
        ...SIGNING_KEY,
        GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '60',
        AI_GRPC_CHAT_DEADLINE_MS: '55000',
      }).onModuleInit(),
    ).not.toThrow();
    expect(() =>
      adapter({ ...SIGNING_KEY, AI_GRPC_CHAT_DEADLINE_MS: '116000' }).onModuleInit(),
    ).toThrow(/GRPC_PRINCIPAL_ASSERTION_TTL_SEC/);
  });
});
