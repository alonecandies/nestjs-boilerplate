import type { MyTenantList } from '@domain/identity-contracts';
import { Query } from '@nestjs/cqrs';

/** The caller's tenants and roles, most recently active first. */
export class ListMyTenantsQuery extends Query<MyTenantList> {
  constructor(readonly userId: string) {
    super();
  }
}
