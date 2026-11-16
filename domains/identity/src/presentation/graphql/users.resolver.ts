import { Args, Query, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { GraphQLUUID } from '@platform/graphql';
import { UsersPort } from '../../application/ports/users.port.js';
import { IdentityPermission } from '../../identity.permissions.js';
import { assertCanReadUser } from '../shared/user-access.policy.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { UsersArgs } from './args/users.args.js';
import { toUserConnectionModel, toUserModel } from './graphql.mapper.js';
import { UserModel } from './models/user.model.js';
import { UserConnectionModel } from './models/user-connection.model.js';

/**
 * Same ports, cache and RBAC rules as `UsersController`. Guards are the global ones
 * (JwtAuthGuard → RolesGuard → PermissionsGuard), which are GraphQL-context aware.
 */
@Resolver(() => UserModel)
export class UsersResolver {
  constructor(
    private readonly usersPort: UsersPort,
    private readonly cache: UserReadCache,
  ) {}

  @Query(() => UserModel, { description: 'The authenticated user' })
  async me(@CurrentUser('id') userId: string): Promise<UserModel> {
    return toUserModel(await this.cache.getUser(userId));
  }

  @Query(() => UserModel, {
    description: 'A user: yourself, or a member of your active tenant with `users:read`',
  })
  async user(
    @Args('id', { type: () => GraphQLUUID }) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserModel> {
    assertCanReadUser(actor, id);
    const user =
      actor.id === id
        ? await this.cache.getUser(id)
        : await this.cache.getScopedUser(id, { tenantId: actor.tenantId });
    return toUserModel(user);
  }

  @Query(() => UserConnectionModel, {
    description: 'Members of your active tenant, newest first (requires `users:read`)',
    // A page fans out to up to MAX_PAGE_LIMIT users: cost it above a single lookup.
    complexity: 10,
  })
  @RequirePermissions(IdentityPermission.UsersRead)
  async users(
    @Args() args: UsersArgs,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserConnectionModel> {
    const page = await this.usersPort.listUsers({
      tenantId: actor.tenantId,
      limit: args.limit,
      cursor: args.cursor ?? undefined,
      search: args.search ?? undefined,
    });
    return toUserConnectionModel(page);
  }
}
