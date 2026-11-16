import type {
  CreateTenantRequest,
  ListMyTenantsRequest,
  MyTenant,
  MyTenantList,
  RenameTenantRequest,
  Tenant,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateTenantCommand } from '../../../application/commands/create-tenant/create-tenant.command.js';
import { RenameTenantCommand } from '../../../application/commands/rename-tenant/rename-tenant.command.js';
import type { TenantsPort } from '../../../application/ports/tenants.port.js';
import { ListMyTenantsQuery } from '../../../application/queries/list-my-tenants/list-my-tenants.query.js';

/** Monolith binding of `TenantsPort`: the CQRS buses of `IdentityCoreModule`. */
@Injectable()
export class TenantsLocalAdapter implements TenantsPort {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  listMyTenants(input: ListMyTenantsRequest): Promise<MyTenantList> {
    return this.queryBus.execute(new ListMyTenantsQuery(input.userId));
  }

  createTenant(input: CreateTenantRequest): Promise<MyTenant> {
    return this.commandBus.execute(new CreateTenantCommand(input.userId, input.name));
  }

  renameTenant(input: RenameTenantRequest): Promise<Tenant> {
    return this.commandBus.execute(
      new RenameTenantCommand(input.tenantId, input.actorId, input.name),
    );
  }
}
