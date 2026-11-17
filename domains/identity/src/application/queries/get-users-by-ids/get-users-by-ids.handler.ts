import type { User } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { DomainValidationException, getPrincipal, isUuid, SystemContext } from '@platform/common';
import { keyBy, uniq } from 'lodash-es';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { toUserContract } from '../../mappers/user.mapper.js';
import { SYSTEM_READS } from '../../persistence/system-reads.js';
import { type UserRecord, UsersRepository } from '../../persistence/users.repository.js';
import { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { GetUsersByIdsQuery } from './get-users-by-ids.query.js';

/**
 * DataLoader backend (`Payment.user`): one lookup for the whole batch. Non-uuid ids cannot exist
 * (and would make Postgres reject the uuid cast), so they are dropped like unknown ids.
 *
 * The scope is the request principal's tenant (the query carries none: the loader serves one
 * operation of one principal). Under the row-local policies a runtime read returns only the caller's
 * own `users` row, so the co-members are a system read (`users.findByIdsInTenant`, reason
 * `identity.user-directory`) joined to `memberships` on that tenant in SQL: a user who is not a
 * member of it resolves to nothing. A principal without a tenant reads on the runtime path (its
 * own row only); no principal fails there (RLS_NO_PRINCIPAL).
 */
@QueryHandler(GetUsersByIdsQuery)
export class GetUsersByIdsHandler implements IQueryHandler<GetUsersByIdsQuery> {
  constructor(
    private readonly users: UsersRepository,
    private readonly usersSystem: UsersSystemRepository,
  ) {}

  async execute(query: GetUsersByIdsQuery): Promise<User[]> {
    const ids = uniq(query.ids).filter(isUuid);
    if (ids.length > IDENTITY_LIMITS.USERS_BATCH_MAX) {
      throw new DomainValidationException('Too many ids', {
        issues: [{ path: 'ids', message: `At most ${IDENTITY_LIMITS.USERS_BATCH_MAX} ids` }],
      });
    }
    if (ids.length === 0) return [];
    const byId = keyBy(await this.lookup(ids), 'id');
    // Order follows the request (the DB returns rows in any order).
    return ids.flatMap((id) => {
      const user = byId[id];
      return user ? [toUserContract(user)] : [];
    });
  }

  private lookup(ids: readonly string[]): Promise<UserRecord[]> {
    const tenantId = getPrincipal()?.tenantId ?? null;
    if (tenantId === null) return this.users.findByIds(ids);
    return SystemContext.run(SYSTEM_READS.USER_DIRECTORY, () =>
      this.usersSystem.findByIdsInTenant(ids, tenantId),
    );
  }
}
