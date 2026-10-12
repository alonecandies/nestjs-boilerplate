import { describe, expect, it } from 'vitest';
import { identityGrpcClientConfig } from './identity-grpc-client.config.js';

describe('identityGrpcClientConfig (IDENTITY_GRPC_URL, read by IdentityApiModule.forRemote())', () => {
  it('defaults to identity-service on its host-dev port', () => {
    expect(identityGrpcClientConfig.parse({})).toEqual({ url: 'localhost:50051' });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      identityGrpcClientConfig.parse({ IDENTITY_GRPC_URL: 'dns:///identity-service:50051' }).url,
    ).toBe('dns:///identity-service:50051');
    expect(identityGrpcClientConfig.parse({ IDENTITY_GRPC_URL: '  ' }).url).toBe('localhost:50051');
  });

  it('is its own namespace, owned by identity', () => {
    expect(identityGrpcClientConfig.KEY).toBe('CONFIGURATION(identityGrpcClient)');
  });
});
