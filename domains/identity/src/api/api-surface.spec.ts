import { IdentityApiModule } from '../identity-api.module.js';
import { IdentityCoreModule } from '../identity-core.module.js';
import * as root from '../index.js';
import * as testing from '../testing/index.js';
import * as api from './index.js';

/** Runtime values of `@domain/identity/api` (types are erased). */
const API_VALUES = [
  'IDENTITY_RBAC',
  'IdentityPermission',
  'AuthPayloadModel',
  'AuthPort',
  'IDENTITY_LIMITS',
  'IdentityApiModule',
  'IdentityErrorCode',
  'MembersPort',
  'TenantRoleEnum',
  'TenantsPort',
  'USERS_LOADER',
  'USER_CACHE_TTL_MS',
  'UserConnectionModel',
  'UserModel',
  'UserResponse',
  'UsersLoaderRegistrar',
  'UsersPort',
  'identityGrpcClientConfig',
  'identityGrpcClientEnvSchema',
  'identityRateLimitConfig',
  'userCacheKey',
];

describe('@domain/identity entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports every ./api value', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
  });

  it('keeps hashing and token issuance out of the root entry', () => {
    for (const name of [
      'PasswordHasher',
      'TokenIssuer',
      'DEV_JWT_REFRESH_SECRET',
      'MAX_PASSWORD_LENGTH',
    ]) {
      expect(root).not.toHaveProperty(name);
    }
    expect(root).toHaveProperty('IdentityCoreModule');
    expect(root).toHaveProperty('refreshTokenConfig');
  });

  it('offers TokenIssuer to tests through ./testing', () => {
    expect(testing).toHaveProperty('TokenIssuer');
  });

  it('forLocal() binds the ports without importing IdentityCoreModule (the app imports it)', () => {
    expect(IdentityApiModule.forLocal().imports ?? []).not.toContain(IdentityCoreModule);
  });
});
