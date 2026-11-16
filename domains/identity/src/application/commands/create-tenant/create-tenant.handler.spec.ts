import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { TENANT_SLUG_PATTERN } from '../../../domain/tenant-slug.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { CreateTenantCommand } from './create-tenant.command.js';
import { CreateTenantHandler } from './create-tenant.handler.js';

describe('CreateTenantHandler', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: CreateTenantHandler;
  const userId = generateId();
  const self = createPrincipal({ userId, tenantId: generateId(), roles: ['owner'] });
  const run = (command: CreateTenantCommand) =>
    runWithPrincipal(self, () => handler.execute(command));

  beforeEach(() => {
    persistence = createInMemoryIdentityPersistence();
    handler = new CreateTenantHandler(
      persistence.tenants,
      persistence.memberships,
      persistence.transactions,
    );
  });

  it('creates a non-personal tenant with the caller as its only owner', async () => {
    const created = await run(new CreateTenantCommand(userId, '  Acme Corp  '));

    expect(created).toMatchObject({
      tenant: { name: 'Acme Corp', personal: false },
      roles: ['owner'],
    });
    expect(created.tenant?.slug).toMatch(TENANT_SLUG_PATTERN);
    expect(created.tenant?.slug).toMatch(/^acme-corp-[0-9a-f]{8}$/);
    await expect(persistence.memberships.find(created.tenant!.id, userId)).resolves.toMatchObject({
      roles: ['owner'],
    });
  });

  it.each(['', '   ', 'x'.repeat(101)])(
    'rejects the name %j with VALIDATION_FAILED',
    async (name) => {
      await expect(run(new CreateTenantCommand(userId, name))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(persistence.store.tenants.size).toBe(0);
    },
  );

  it('403 TENANT_ACCESS_DENIED when the request names another user (gRPC cross-check)', async () => {
    await expect(run(new CreateTenantCommand(generateId(), 'Acme'))).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
    });
    expect(persistence.store.tenants.size).toBe(0);
  });
});
