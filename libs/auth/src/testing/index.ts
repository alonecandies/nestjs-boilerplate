/**
 * @platform/auth/testing — test helpers for code that depends on @platform/auth. Not imported by
 * production code (separate subpath so it never lands in a service's module graph).
 */

export { makeAuthUser } from './auth-test.utils.js';
export { type SignTestAccessTokenOptions, signTestAccessToken } from './sign-test-access-token.js';
