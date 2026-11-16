/**
 * @platform/auth/testing — test helpers for code that depends on @platform/auth. Not imported by
 * production code (separate subpath so it never lands in a service's module graph).
 */

export { makeAuthUser } from './auth-test.utils.js';
export { createTestRbacRegistry, TEST_RBAC_FEATURE } from './rbac-test.utils.js';
export {
  type SignTestAccessTokenOptions,
  signTestAccessToken,
  type TestAccessTokenSubject,
} from './sign-test-access-token.js';
export { TEST_TENANT_ID } from './test-tenant.js';
