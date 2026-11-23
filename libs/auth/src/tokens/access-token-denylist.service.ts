import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ServiceUnavailableException, withTimeout } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { InjectRedis, InjectRedisSubscriber, RedisKeyService } from '@platform/redis';
import type { Redis } from 'ioredis';
import { isPlainObject, isString } from 'lodash-es';
import { DENYLIST_CHECK_TIMEOUT_MS, JWT_CLOCK_TOLERANCE_SEC } from '../auth.constants.js';

/** Receives the jti of an access token revoked on any replica. */
export type RevokedTokenListener = (jti: string) => void;

/** The payload on `${prefix}:auth:revoked`: `{"jti":"<jti>"}` (a wire contract between replicas). */
interface RevocationMessage {
  jti: string;
}

/**
 * The jti of a revocation message, or `undefined` for a malformed one. The channel is shared by
 * every replica and version, so its payload shape is never trusted.
 */
function parseRevocationMessage(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const { jti } = parsed as Partial<Record<keyof RevocationMessage, unknown>>;
  return isString(jti) && jti.length > 0 ? jti : undefined;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Revoked access tokens (logout, admin "log out everywhere"): `${prefix}:auth:denylist:{jti}`
 * with a TTL equal to the token's remaining lifetime (+ clock tolerance), so the set never grows
 * beyond the tokens that are still valid. Checked on every authenticated request — one EXISTS,
 * auto-pipelined by ioredis, bounded to `DENYLIST_CHECK_TIMEOUT_MS` (250 ms).
 *
 * Fails CLOSED: if Redis cannot answer in time (error, or a command parked in ioredis' offline
 * queue while it reconnects), authenticated requests get 503 rather than silently accepting a
 * possibly revoked token. `AUTH_DENYLIST_ENABLED=false` turns it into a no-op.
 *
 * `deny()` also announces the jti on `${prefix}:auth:revoked`, so every replica's
 * `RevocationSweeper` closes that token's live WebSockets at once (`onRevoked`). The announcement
 * is best effort; the denylist key stays the source of truth and the timed sweep the fallback.
 */
@Injectable()
export class AccessTokenDenylist implements OnModuleDestroy {
  private readonly logger = new Logger(AccessTokenDenylist.name);
  private readonly listeners = new Set<RevokedTokenListener>();
  private readonly channel: string;
  private readonly onMessage: (channel: string, message: string) => void;
  private subscribed = false;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    // The shared subscriber connection (`RedisModule`). Without it this replica does not listen
    // to the revocation channel and its WebSockets close at the next sweep.
    @Optional() @InjectRedisSubscriber() private readonly subscriber?: Redis,
  ) {
    this.channel = keys.key('auth', 'revoked');
    this.onMessage = (channel, message) => {
      this.handleMessage(channel, message);
    };
  }

  get enabled(): boolean {
    return this.config.denylistEnabled;
  }

  onModuleDestroy(): void {
    // The connection itself is closed by RedisModule (after every module is destroyed).
    this.subscriber?.off('message', this.onMessage);
  }

  /**
   * Revokes `jti` for as long as verifiers could still accept the token (`exp` + clock
   * tolerance), then announces it on `${prefix}:auth:revoked`. No-op for tokens that can no
   * longer be accepted anyway. A failed announcement is logged, never thrown: the key is set, and
   * live sockets close at the next sweep instead.
   */
  async deny(jti: string, expEpochSec: number): Promise<void> {
    if (!this.enabled) return;
    const ttlSec = Math.ceil(expEpochSec - Date.now() / 1_000) + JWT_CLOCK_TOLERANCE_SEC;
    if (ttlSec <= 0) return;
    await this.redis.set(this.key(jti), '1', 'EX', ttlSec);
    await this.announce(jti);
  }

  async isDenied(jti: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const count = await withTimeout(
        this.redis.exists(this.key(jti)),
        DENYLIST_CHECK_TIMEOUT_MS,
        'Token revocation check timed out',
      );
      return count === 1;
    } catch (error) {
      throw new ServiceUnavailableException('Token revocation check is temporarily unavailable', {
        cause: error,
      });
    }
  }

  /**
   * Calls `listener(jti)` for each token any replica denies from now on, as its announcement
   * arrives on `${prefix}:auth:revoked`. Best effort: a message sent while this replica's
   * subscriber is disconnected is lost, so keep a timed `isDenied` check as the fallback.
   * Malformed messages are ignored; a throwing listener is logged and does not stop the others.
   * Subscribes once (lazily, on the first listener) and stays subscribed. Returns an idempotent
   * function that removes the listener. A no-op when the denylist is disabled or there is no
   * subscriber connection.
   */
  onRevoked(listener: RevokedTokenListener): () => void {
    const { subscriber } = this;
    if (!this.enabled || subscriber === undefined) return () => undefined;
    // Its own entry, so registering one function twice needs two removals.
    const entry: RevokedTokenListener = (jti) => {
      listener(jti);
    };
    this.listeners.add(entry);
    this.subscribe(subscriber);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private subscribe(subscriber: Redis): void {
    if (this.subscribed) return;
    this.subscribed = true;
    subscriber.on('message', this.onMessage);
    // Not awaited: the subscriber connects lazily and ioredis re-subscribes after reconnects.
    subscriber.subscribe(this.channel).catch((error: unknown) => {
      subscriber.off('message', this.onMessage);
      this.subscribed = false;
      this.logger.warn(`cannot subscribe to ${this.channel}: ${errorMessage(error)}`);
    });
  }

  private async announce(jti: string): Promise<void> {
    const message: RevocationMessage = { jti };
    try {
      await this.redis.publish(this.channel, JSON.stringify(message));
    } catch (error) {
      // Never the jti: it identifies a live token.
      this.logger.warn(
        `Revocation broadcast failed, live sockets close at the next sweep: ${errorMessage(error)}`,
      );
    }
  }

  private handleMessage(channel: string, message: string): void {
    if (channel !== this.channel) return;
    const jti = parseRevocationMessage(message);
    if (jti === undefined) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(jti);
      } catch (error) {
        this.logger.warn(`A revocation listener failed: ${errorMessage(error)}`);
      }
    }
  }

  private key(jti: string): string {
    return this.keys.key('auth', 'denylist', jti);
  }
}
