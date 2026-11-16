import { IDENTITY_GRPC_PACKAGE, TENANTS_SERVICE_NAME } from '@domain/identity-contracts';
import { Metadata } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { generateId } from '@platform/common';
import { lastValueFrom, type Observable, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityGrpcCaller } from './identity-grpc.caller.js';
import { MembersGrpcAdapter } from './members-grpc.adapter.js';
import { TenantsGrpcAdapter } from './tenants-grpc.adapter.js';

const tenantId = generateId();

function adapters(service: Record<string, (req: unknown, md: Metadata) => Observable<unknown>>) {
  // `getService` is generic, which a mapped mock type cannot satisfy: cast the stand-in once.
  const client = { getService: vi.fn().mockReturnValue(service) } as unknown as ClientGrpc;
  const operations: string[] = [];
  // Private members (breaker, config) keep a mapped mock type from matching the class.
  const caller = {
    call: vi.fn((operation: string, invoke: (md: Metadata) => Observable<unknown>) => {
      operations.push(operation);
      return lastValueFrom(invoke(new Metadata()));
    }),
  } as unknown as IdentityGrpcCaller;
  const tenants = new TenantsGrpcAdapter(client, caller);
  const members = new MembersGrpcAdapter(client, caller);
  tenants.onModuleInit();
  members.onModuleInit();
  return { tenants, members, operations };
}

describe('tenancy gRPC adapters (gateway)', () => {
  it('name operations after the package and service (G-11) and normalise proto-loader nulls', async () => {
    const { tenants, operations } = adapters({
      listMyTenants: () =>
        of({
          items: [
            {
              tenant: { id: tenantId, slug: 's', name: 'N', personal: true, createdAt: null },
              roles: null,
              lastActiveAt: null,
            },
          ],
        }),
    });
    await expect(tenants.listMyTenants({ userId: generateId() })).resolves.toEqual({
      items: [
        {
          tenant: { id: tenantId, slug: 's', name: 'N', personal: true, createdAt: undefined },
          roles: [],
        },
      ],
    });
    expect(operations).toEqual([
      `${IDENTITY_GRPC_PACKAGE.package}.${TENANTS_SERVICE_NAME}/ListMyTenants`,
    ]);
  });

  it('drops an empty next_cursor and maps Empty to void', async () => {
    const { members } = adapters({
      listMembers: () => of({ items: null, nextCursor: '' }),
      leaveTenant: () => of({}),
    });
    await expect(members.listMembers({ tenantId, limit: 10 })).resolves.toEqual({ items: [] });
    await expect(members.leaveTenant({ tenantId, userId: generateId() })).resolves.toBeUndefined();
  });
});
