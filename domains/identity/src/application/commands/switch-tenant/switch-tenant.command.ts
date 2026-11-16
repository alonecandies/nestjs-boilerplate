import type { AuthTokens, ClientInfo } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/**
 * Moves the caller's session to another tenant (spec §5.2): rotates `refreshToken`'s session into
 * `tenantId` and denylists the current access token (`accessToken.jti` until `accessToken.exp`).
 */
export class SwitchTenantCommand extends Command<AuthTokens> {
  constructor(
    readonly userId: string,
    readonly tenantId: string,
    readonly refreshToken: string,
    readonly accessToken: { readonly jti: string; readonly exp: number },
    readonly client?: ClientInfo | undefined,
  ) {
    super();
  }
}
