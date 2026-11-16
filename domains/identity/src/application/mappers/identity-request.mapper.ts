import type {
  ListUsersRequest,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  StaffSwitchInRequest,
  StaffSwitchOutRequest,
  SwitchTenantRequest,
} from '@domain/identity-contracts';
import { LoginCommand } from '../commands/login/login.command.js';
import { LogoutCommand } from '../commands/logout/logout.command.js';
import { RefreshSessionCommand } from '../commands/refresh-session/refresh-session.command.js';
import { RegisterUserCommand } from '../commands/register-user/register-user.command.js';
import { StaffSwitchInCommand } from '../commands/staff-switch-in/staff-switch-in.command.js';
import { StaffSwitchOutCommand } from '../commands/staff-switch-out/staff-switch-out.command.js';
import { SwitchTenantCommand } from '../commands/switch-tenant/switch-tenant.command.js';
import { ListUsersQuery } from '../queries/list-users/list-users.query.js';

/*
 * Wire request (contract) → command/query. Shared by the local adapters (monolith) and the gRPC
 * controllers (identity-service) so both topologies dispatch exactly the same messages.
 */

export const toRegisterUserCommand = (request: RegisterRequest): RegisterUserCommand =>
  new RegisterUserCommand(request.email, request.password, request.displayName, request.client);

export const toLoginCommand = (request: LoginRequest): LoginCommand =>
  new LoginCommand(request.email, request.password, request.client, request.tenantId);

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

/** An absent tenant becomes '' and fails in the handler (the directory is never global). */
export const toListUsersQuery = (request: ListUsersRequest): ListUsersQuery =>
  new ListUsersQuery(request.tenantId ?? '', request.limit, request.cursor, request.search);

/** `accessTokenExp` is an int64 → string on the wire (ts-proto `forceLong=string`). */
export const toSwitchTenantCommand = (request: SwitchTenantRequest): SwitchTenantCommand =>
  new SwitchTenantCommand(
    request.userId,
    request.tenantId,
    request.refreshToken,
    { jti: request.accessTokenJti, exp: Number(request.accessTokenExp) },
    request.client,
  );

export const toStaffSwitchInCommand = (request: StaffSwitchInRequest): StaffSwitchInCommand =>
  new StaffSwitchInCommand(request.staffUserId, request.tenantId, request.reason, request.client);

export const toStaffSwitchOutCommand = (request: StaffSwitchOutRequest): StaffSwitchOutCommand =>
  new StaffSwitchOutCommand(request.staffUserId, request.tenantId, {
    jti: request.accessTokenJti,
    exp: Number(request.accessTokenExp),
  });
