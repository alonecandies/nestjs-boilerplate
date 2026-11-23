import type { UserPage } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import {
  DomainValidationException,
  isUuid,
  resolvePageSize,
  SystemContext,
} from '@platform/common';
import { trim } from 'lodash-es';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { toUserContract } from '../../mappers/user.mapper.js';
import { SYSTEM_READS } from '../../persistence/system-reads.js';
import { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { requireActingIn } from '../../services/tenant-actor.js';
import { ListUsersQuery } from './list-users.query.js';

@QueryHandler(ListUsersQuery)
export class ListUsersHandler implements IQueryHandler<ListUsersQuery> {
  constructor(private readonly usersSystem: UsersSystemRepository) {}

  async execute(query: ListUsersQuery): Promise<UserPage> {
    if (!isUuid(query.tenantId)) {
      throw new DomainValidationException('A tenant is required', {
        issues: [{ path: 'tenantId', message: 'Must be a UUID' }],
      });
    }
    const search = trim(query.search ?? '').slice(0, IDENTITY_LIMITS.SEARCH_MAX_LENGTH);
    const tenantId = query.tenantId;
    // The tenant's member directory: a system read, for a caller acting in that tenant, with the
    // tenant filter in the SQL.
    requireActingIn(tenantId);
    const page = await SystemContext.run(SYSTEM_READS.USER_DIRECTORY, () =>
      this.usersSystem.listInTenant({
        tenantId,
        // gRPC sends `0` for an absent int32: it (and garbage) means the default page size.
        limit: resolvePageSize(query.limit),
        cursor: query.cursor === '' ? undefined : query.cursor,
        search: search === '' ? undefined : search,
      }),
    );
    return {
      items: page.items.map(toUserContract),
      // Contract: absent (not null) on the last page.
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    };
  }
}
