import type { MyTenantList } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import { toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { MembershipsSystemRepository } from '../../persistence/memberships.system-repository.js';
import { SYSTEM_READS } from '../../persistence/system-reads.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { ListMyTenantsQuery } from './list-my-tenants.query.js';

@QueryHandler(ListMyTenantsQuery)
export class ListMyTenantsHandler implements IQueryHandler<ListMyTenantsQuery> {
  constructor(private readonly membershipsSystem: MembershipsSystemRepository) {}

  async execute({ userId }: ListMyTenantsQuery): Promise<MyTenantList> {
    requireSelf(userId);
    // Every tenant of the caller (asserted by requireSelf): the runtime tenants policy shows only
    // the session tenant, so this is a system read filtered on the user in the SQL.
    const memberships = await SystemContext.run(SYSTEM_READS.MY_TENANTS, () =>
      this.membershipsSystem.listForUser(userId),
    );
    return { items: memberships.map(toMyTenantContract) };
  }
}
