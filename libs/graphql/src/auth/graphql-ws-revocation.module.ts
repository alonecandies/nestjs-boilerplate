import {
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessTokenDenylist, RevocationSweeper } from '@platform/auth';
import { type AuthConfig, authConfig } from '@platform/config';

/** DI token of the graphql-ws `RevocationSweeper` (one per application). */
export const GRAPHQL_WS_REVOCATION_SWEEPER = Symbol('GRAPHQL_WS_REVOCATION_SWEEPER');

/**
 * Holds the one `RevocationSweeper` named `graphql-ws`, built from the global
 * `AccessTokenDenylist` and `WS_REVOCATION_SWEEP_INTERVAL_MS` (`authConfig`). It is a static
 * module, so every importer shares one instance. The sweep starts on application bootstrap and
 * stops on shutdown (`app.close()`), leaving no timer behind.
 */
@Module({
  imports: [ConfigModule.forFeature(authConfig)],
  providers: [
    {
      provide: GRAPHQL_WS_REVOCATION_SWEEPER,
      inject: [AccessTokenDenylist, authConfig.KEY],
      useFactory: (denylist: AccessTokenDenylist, auth: AuthConfig): RevocationSweeper =>
        new RevocationSweeper(denylist, {
          name: 'graphql-ws',
          intervalMs: auth.wsRevocationSweepIntervalMs,
        }),
    },
  ],
  exports: [GRAPHQL_WS_REVOCATION_SWEEPER],
})
export class GraphqlWsRevocationModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(GRAPHQL_WS_REVOCATION_SWEEPER) private readonly sweeper: RevocationSweeper) {}

  onApplicationBootstrap(): void {
    this.sweeper.start();
  }

  onApplicationShutdown(): void {
    this.sweeper.stop();
  }
}
