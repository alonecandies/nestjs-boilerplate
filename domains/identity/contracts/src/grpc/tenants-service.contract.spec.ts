import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANTS_SERVICE_NAME } from '../generated/identity/v1/identity.pb.js';

const proto = readFileSync(
  join(import.meta.dirname, '..', 'proto', 'identity', 'v1', 'identity.proto'),
  'utf8',
);

describe('identity.v1.TenantsService', () => {
  it('is generated', () => {
    expect(TENANTS_SERVICE_NAME).toBe('TenantsService');
  });

  it('declares exactly the tenancy RPCs of spec §5.2 (gRPC mirror of REST)', () => {
    const block = /service TenantsService \{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const rpcs = [...block.matchAll(/rpc (\w+)\(/g)].map((m) => m[1]);
    expect(rpcs).toEqual([
      'ListMyTenants',
      'CreateTenant',
      'RenameTenant',
      'ListMembers',
      'UpdateMemberRoles',
      'RemoveMember',
      'LeaveTenant',
      'CreateInvitation',
      'AcceptInvitation',
    ]);
  });
});
