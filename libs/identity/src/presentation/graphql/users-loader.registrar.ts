import type { User } from '@app/contracts';
import { DataLoaderRegistry } from '@app/graphql';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import DataLoader from 'dataloader';
import { keyBy } from 'lodash-es';
import { UsersPort } from '../../application/ports/users.port.js';
import { IDENTITY_LIMITS, USERS_LOADER } from '../../identity.constants.js';

/** Typed `@Loader(USERS_LOADER)` / `ctx.loaders.users` for every domain that imports this lib. */
declare module '@app/graphql' {
  interface GraphqlLoaders {
    readonly users: DataLoader<string, User | null>;
  }
}

/**
 * Registers the `users` DataLoader: every `load(id)` of one GraphQL operation is coalesced into
 * ONE `UsersPort.getUsersByIds` call (one SQL `IN (...)` locally, one RPC remotely) — e.g.
 * billing's `Payment.user` over a list of payments is 1 lookup, not N. Per-operation instances
 * (no REQUEST scope, no cross-user cache).
 */
@Injectable()
export class UsersLoaderRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: DataLoaderRegistry,
    private readonly users: UsersPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      USERS_LOADER,
      () =>
        new DataLoader<string, User | null>(
          async (ids) => {
            const found = keyBy(await this.users.getUsersByIds(ids), 'id');
            return ids.map((id) => found[id] ?? null);
          },
          { maxBatchSize: IDENTITY_LIMITS.USERS_BATCH_MAX },
        ),
    );
  }
}
