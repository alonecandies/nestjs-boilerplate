import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ServiceUnavailableException, withTimeout } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import {
  InjectRedis,
  InjectRedisSubscriber,
  RedisKeyService,
  subscribeToChannel,
} from '@platform/redis';
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
 * `deny()` also announces the jti on `${prefix}:auth:revoked`, in the same pipeline as the key (one
 * round trip), so every replica's `RevocationSweeper` closes that token's live WebSockets at once
 * (`onRevoked`). The announcement is best effort; the denylist key stays the source of truth and
 * the timed sweep the fallback.
 */
@Injectable()
export class AccessTokenDenylist implements OnModuleDestroy {
  private readonly logger = new Logger(AccessTokenDenylist.name);
  private readonly listeners = new Set<RevokedTokenListener>();
  private readonly channel: string;
  /** Detaches the channel listener; set from the first listener on, unset by a failed SUBSCRIBE. */
  private unlisten: (() => void) | undefined;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    // The shared subscriber connection (`RedisModule`). Without it this replica does not listen
    // to the revocation channel and its WebSockets close at the next sweep.
    @Optional() @InjectRedisSubscriber() private readonly subscriber?: Redis,
  ) {
    this.channel = keys.key('auth', 'revoked');
  }

  get enabled(): boolean {
    return this.config.denylistEnabled;
  }

  onModuleDestroy(): void {
    // The connection itself is closed by RedisModule (after every module is destroyed).
    this.unlisten?.();
  }

  /**
   * Revokes `jti` for as long as verifiers could still accept the token (`exp` + clock
   * tolerance) and announces it on `${prefix}:auth:revoked`: `SET` and `PUBLISH` in one pipeline,
   * one round trip. No-op for tokens that can no longer be accepted anyway.
   *
   * A failed `SET` (or a pipeline that fails or brings back no reply for it) rejects: the token
   * is not revoked. The `PUBLISH` beside it may still have gone out, which only closes the
   * token's sockets early. A failed announcement is logged, never thrown: the key is set, and live
   * sockets close at the next sweep instead.
   */
  async deny(jti: string, expEpochSec: number): Promise<void> {
    if (!this.enabled) return;
    const ttlSec = Math.ceil(expEpochSec - Date.now() / 1_000) + JWT_CLOCK_TOLERANCE_SEC;
    if (ttlSec <= 0) return;
    const message: RevocationMessage = { jti };
    const [stored, announced] =
      (await this.redis
        .pipeline()
        .set(this.key(jti), '1', 'EX', ttlSec)
        .publish(this.channel, JSON.stringify(message))
        .exec()) ?? [];
    if (stored === undefined) throw new Error('Redis brought back no reply for the revocation');
    const [setError] = stored;
    if (setError !== null) throw setError;
    const publishError = announced === undefined ? new Error('no reply') : announced[0];
    if (publishError !== null) {
      // Never the jti: it identifies a live token.
      this.logger.warn(
        `Revocation broadcast failed, live sockets close at the next sweep: ${errorMessage(publishError)}`,
      );
    }
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
    if (this.unlisten !== undefined) return;
    const unlisten = subscribeToChannel(
      subscriber,
      this.channel,
      (message) => {
        this.handleMessage(message);
      },
      {
        logger: this.logger,
        // ioredis does not retry a failed SUBSCRIBE: stop listening, and let the next
        // `onRevoked` subscribe again.
        onError: () => {
          unlisten();
          if (this.unlisten === unlisten) this.unlisten = undefined;
        },
      },
    );
    this.unlisten = unlisten;
  }

  private handleMessage(message: string): void {
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
