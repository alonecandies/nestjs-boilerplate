import { Command } from '@nestjs/cqrs';

/** Platform staff leaves `tenantId`: the switch-in token is revoked and the exit audited. */
export class StaffSwitchOutCommand extends Command<void> {
  constructor(
    readonly staffUserId: string,
    readonly tenantId: string,
    readonly accessToken: { readonly jti: string; readonly exp: number },
  ) {
    super();
  }
}
