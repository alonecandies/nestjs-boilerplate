import { DomainValidationException, isUuid } from '@app/common';
import type { User } from '@app/contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { keyBy, uniq } from 'lodash-es';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { toUserContract } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { GetUsersByIdsQuery } from './get-users-by-ids.query.js';

/**
 * DataLoader backend: one `WHERE id IN (...)` for the whole batch. Non-uuid ids cannot exist
 * (and would make Postgres reject the uuid cast), so they are dropped like unknown ids.
 */
@QueryHandler(GetUsersByIdsQuery)
export class GetUsersByIdsHandler implements IQueryHandler<GetUsersByIdsQuery> {
  constructor(private readonly users: UsersRepository) {}

  async execute(query: GetUsersByIdsQuery): Promise<User[]> {
    const ids = uniq(query.ids).filter(isUuid);
    if (ids.length > IDENTITY_LIMITS.USERS_BATCH_MAX) {
      throw new DomainValidationException('Too many ids', {
        issues: [{ path: 'ids', message: `At most ${IDENTITY_LIMITS.USERS_BATCH_MAX} ids` }],
      });
    }
    if (ids.length === 0) return [];
    const byId = keyBy(await this.users.findByIds(ids), 'id');
    // Order follows the request (the DB returns rows in any order).
    return ids.flatMap((id) => {
      const user = byId[id];
      return user ? [toUserContract(user)] : [];
    });
  }
}
