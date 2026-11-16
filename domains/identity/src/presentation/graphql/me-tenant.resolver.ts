import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser } from '@platform/auth';
import { TenantsPort } from '../../application/ports/tenants.port.js';
import { ActiveTenantModel } from './models/active-tenant.model.js';
import { UserModel } from './models/user.model.js';
import { toActiveTenantModel } from './tenancy.mapper.js';

/** `User.activeTenant`: the caller's own tenancy view, hung on the `me` query's `User`. */
@Resolver(() => UserModel)
export class MeTenantResolver {
  constructor(private readonly tenants: TenantsPort) {}

  @ResolveField(() => ActiveTenantModel, {
    nullable: true,
    description: 'Only on yourself (`me`): the tenant this access token acts in, with your roles',
  })
  async activeTenant(
    @Parent() user: UserModel,
    @CurrentUser() actor: AuthUser,
  ): Promise<ActiveTenantModel | null> {
    if (user.id !== actor.id) return null;
    const mine = actor.staff ? [] : (await this.tenants.listMyTenants({ userId: actor.id })).items;
    return toActiveTenantModel(actor, mine);
  }
}
