import type {
  ListUsersRequest,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  UpdateUserRolesRequest,
} from '@app/contracts';
import { LoginCommand } from '../commands/login/login.command.js';
import { LogoutCommand } from '../commands/logout/logout.command.js';
import { RefreshSessionCommand } from '../commands/refresh-session/refresh-session.command.js';
import { RegisterUserCommand } from '../commands/register-user/register-user.command.js';
import { UpdateUserRolesCommand } from '../commands/update-user-roles/update-user-roles.command.js';
import { ListUsersQuery } from '../queries/list-users/list-users.query.js';

/*
 * Wire request (contract) → command/query. Shared by the local adapters (monolith) and the gRPC
 * controllers (identity-service) so both topologies dispatch exactly the same messages.
 */

export const toRegisterUserCommand = (request: RegisterRequest): RegisterUserCommand =>
  new RegisterUserCommand(request.email, request.password, request.displayName, request.client);

export const toLoginCommand = (request: LoginRequest): LoginCommand =>
  new LoginCommand(request.email, request.password, request.client);

export const toRefreshSessionCommand = (request: RefreshTokensRequest): RefreshSessionCommand =>
  new RefreshSessionCommand(request.refreshToken, request.client);

/** `accessTokenExp` is an int64 → string on the wire (ts-proto `forceLong=string`). */
export const toLogoutCommand = (request: LogoutRequest): LogoutCommand =>
  new LogoutCommand(
    request.userId,
    request.accessTokenJti,
    Number(request.accessTokenExp),
    request.refreshToken,
  );

export const toUpdateUserRolesCommand = (request: UpdateUserRolesRequest): UpdateUserRolesCommand =>
  new UpdateUserRolesCommand(request.id, request.roles, request.actorId);

export const toListUsersQuery = (request: ListUsersRequest): ListUsersQuery =>
  new ListUsersQuery(request.limit, request.cursor, request.search);
