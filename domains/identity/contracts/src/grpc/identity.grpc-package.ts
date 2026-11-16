import { join } from 'node:path';
import type { GrpcPackageSpec } from '@platform/contracts';
// Value import on purpose: evaluating the generated module registers ts-proto's
// google.protobuf.Timestamp <-> Date wrapper on the shared protobufjs instance. Every process that
// builds gRPC options for this package loads this file, so Timestamps can never silently decode
// as `{ seconds, nanos }` because a service only imported contract *types*.
import {
  AUTH_SERVICE_NAME,
  TENANTS_SERVICE_NAME,
  USERS_SERVICE_NAME,
} from '../generated/identity/v1/identity.pb.js';

/**
 * `identity.v1`: AuthService (credential flows), UsersService (user queries and admin) and
 * TenantsService: tenants, members, invitations (B2-17).
 */
export const IDENTITY_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'identity.v1',
  // `src/grpc` and `dist/grpc` sit at the same depth and swc `copyFiles` mirrors `src/proto/**`.
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['identity/v1/identity.proto'],
  services: [AUTH_SERVICE_NAME, USERS_SERVICE_NAME, TENANTS_SERVICE_NAME],
  clientToken: 'IDENTITY_GRPC_CLIENT',
  // AuthService is deliberately absent: none of its calls is idempotent (Register, Login,
  // RefreshTokens, Logout, SwitchTenant, StaffSwitchIn and StaffSwitchOut are never retried). Of
  // TenantsService only the two reads are retried; every tenant, member and invitation write is not.
  idempotentMethods: {
    [USERS_SERVICE_NAME]: ['GetUser', 'GetUsersByIds', 'ListUsers'],
    [TENANTS_SERVICE_NAME]: ['ListMyTenants', 'ListMembers'],
  },
};
