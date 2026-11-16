import type {
  AuthTokens,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  StaffAccessToken,
  StaffSwitchInRequest,
  StaffSwitchOutRequest,
  SwitchTenantRequest,
} from '@domain/identity-contracts';

/**
 * Authentication flows as seen by the presentation layer (REST, GraphQL, passport-local).
 * Bound per topology by `IdentityApiModule`: `.forLocal()` → `AuthLocalAdapter` (CommandBus, same
 * process), `.forRemote()` → `AuthGrpcAdapter` (identity-service over gRPC). Both return the same
 * `@domain/identity-contracts` shapes and throw the same `DomainException`s (codes survive the gRPC
 * hop).
 */
export abstract class AuthPort {
  /** @throws EmailAlreadyTakenException (409 EMAIL_TAKEN) */
  abstract register(input: RegisterRequest): Promise<AuthTokens>;

  /** @throws InvalidCredentialsException (401 INVALID_CREDENTIALS) | TenantAccessDeniedException (403 TENANT_ACCESS_DENIED, only when `tenantId` is given) */
  abstract login(input: LoginRequest): Promise<AuthTokens>;

  /**
   * Rotates the refresh token (the presented one is revoked).
   * @throws InvalidRefreshTokenException | SessionExpiredException | RefreshTokenReuseDetectedException (401)
   */
  abstract refreshTokens(input: RefreshTokensRequest): Promise<AuthTokens>;

  /**
   * Denylists the access token for its remaining lifetime and revokes the session bound to
   * `refreshToken` — or every session of the user when it is absent ("sign out everywhere").
   */
  abstract logout(input: LogoutRequest): Promise<void>;

  /**
   * Moves the caller's session to `tenantId`: the refresh token is rotated into a session there and the
   * current access token is denylisted.
   * @throws TenantAccessDeniedException (403) | InvalidRefreshTokenException | SessionExpiredException |
   *   RefreshTokenReuseDetectedException (401)
   */
  abstract switchTenant(input: SwitchTenantRequest): Promise<AuthTokens>;

  /**
   * Platform staff enters `tenantId` (audited). Access token only.
   * @throws NotPlatformStaffException (403 STAFF_ONLY) | EntityNotFoundException (404) |
   *   DomainValidationException (422; the REST DTO and the RPC schema answer 400 / INVALID_ARGUMENT first)
   */
  abstract staffSwitchIn(input: StaffSwitchInRequest): Promise<StaffAccessToken>;

  /** Revokes a staff switch-in token and audits the exit (the edge ensures it is one: `@StaffOnly()`). */
  abstract staffSwitchOut(input: StaffSwitchOutRequest): Promise<void>;
}
