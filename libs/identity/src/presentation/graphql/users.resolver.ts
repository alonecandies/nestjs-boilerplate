import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@app/auth';
import { GraphQLUUID } from '@app/graphql';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UsersPort } from '../../application/ports/users.port.js';
import { assertCanReadUser } from '../shared/user-access.policy.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { UsersArgs } from './args/users.args.js';
import { toUserConnectionModel, toUserModel } from './graphql.mapper.js';
import { UpdateUserRolesInput } from './inputs/update-user-roles.input.js';
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

  @Query(() => UserModel, { description: 'A user: yourself, or anyone with `users:read`' })
  async user(
    @Args('id', { type: () => GraphQLUUID }) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserModel> {
    assertCanReadUser(actor, id);
    return toUserModel(await this.cache.getUser(id));
  }

  @Query(() => UserConnectionModel, {
    description: 'Users, newest first (requires `users:read`)',
    // A page fans out to up to MAX_PAGE_LIMIT users: cost it above a single lookup.
    complexity: 10,
  })
  @RequirePermissions(Permission.UsersRead)
  async users(@Args() args: UsersArgs): Promise<UserConnectionModel> {
    const page = await this.usersPort.listUsers({
      limit: args.limit,
      cursor: args.cursor ?? undefined,
      search: args.search ?? undefined,
    });
    return toUserConnectionModel(page);
  }

  @Mutation(() => UserModel, {
    description: "Replace a user's roles (requires `users:manage-roles`)",
  })
  @RequirePermissions(Permission.UsersManageRoles)
  async updateUserRoles(
    @Args('input') input: UpdateUserRolesInput,
    @CurrentUser('id') actorId: string,
  ): Promise<UserModel> {
    const user = await this.usersPort.updateUserRoles({
      id: input.id,
      roles: input.roles,
      actorId,
    });
    await this.cache.invalidate(input.id);
    return toUserModel(user);
  }
}
