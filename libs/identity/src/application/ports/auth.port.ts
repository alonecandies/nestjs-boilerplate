import type {
  AuthTokens,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
} from '@app/contracts';

/**
 * Authentication flows as seen by the presentation layer (REST, GraphQL, passport-local).
 * Bound per topology by `IdentityApiModule`: `.forLocal()` → `AuthLocalAdapter` (CommandBus, same
 * process), `.forRemote()` → `AuthGrpcAdapter` (identity-service over gRPC). Both return the same
 * `@app/contracts` shapes and throw the same `DomainException`s (codes survive the gRPC hop).
 */
export abstract class AuthPort {
  /** @throws EmailAlreadyTakenException (409 EMAIL_TAKEN) */
  abstract register(input: RegisterRequest): Promise<AuthTokens>;

  /** @throws InvalidCredentialsException (401 INVALID_CREDENTIALS) */
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
}
