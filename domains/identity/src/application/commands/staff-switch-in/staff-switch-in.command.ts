import type { ClientInfo, StaffAccessToken } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** Platform staff enters `tenantId` for support (spec §5.2): an audited, short-lived admin token. */
export class StaffSwitchInCommand extends Command<StaffAccessToken> {
  constructor(
    readonly staffUserId: string,
    readonly tenantId: string,
    readonly reason: string,
    readonly client?: ClientInfo | undefined,
  ) {
    super();
  }
}
