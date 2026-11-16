/**
 * @domain/identity/testing — test doubles for code that depends on the identity context: the
 * in-memory persistence behind the real handlers (monolith e2e) and a fake identity-service behind
 * `AuthPort`/`UsersPort` (gateway e2e). Not imported by production code (a separate subpath, so it
 * never lands in a service's module graph).
 */

// Identity's real signer: fakes and the gateway e2e mint refresh tokens with it (not a production export).
export { TokenIssuer } from '../infrastructure/security/token-issuer.service.js';
export * from './fake-identity-ports.js';
export * from './in-memory-identity.js';
export * from './in-memory-tenancy.js';
