import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@app/common';
import type { UserPage } from '@app/contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { clamp, isNil, trim } from 'lodash-es';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { toUserContract } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { ListUsersQuery } from './list-users.query.js';

/** gRPC sends `0` for an absent int32: treat it (and garbage) as "default page size". */
function pageLimit(limit: number | undefined): number {
  if (isNil(limit) || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return clamp(Math.trunc(limit), 1, MAX_PAGE_LIMIT);
}

@QueryHandler(ListUsersQuery)
export class ListUsersHandler implements IQueryHandler<ListUsersQuery> {
  constructor(private readonly users: UsersRepository) {}

  async execute(query: ListUsersQuery): Promise<UserPage> {
    const search = trim(query.search ?? '').slice(0, IDENTITY_LIMITS.SEARCH_MAX_LENGTH);
    const page = await this.users.list({
      limit: pageLimit(query.limit),
      cursor: query.cursor === '' ? undefined : query.cursor,
      search: search === '' ? undefined : search,
    });
    return {
      items: page.items.map(toUserContract),
      // Contract: absent (not null) on the last page.
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    };
  }
}
