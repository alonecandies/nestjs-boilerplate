import { Logger } from '@nestjs/common';
import type { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';

/** A live WebSocket session authenticated with the access token `jti`. */
export interface RevocableSession {
  readonly jti: string;
  /** Tell the client why, then close. Must not throw. */
  end(): void;
}

export interface RevocationSweeperOptions {
  /** Names the transport in logs (e.g. `graphql-ws`). */
  name: string;
  /** Period of the sweep started by `start()` (`WS_REVOCATION_SWEEP_INTERVAL_MS`). */
  intervalMs: number;
}

/**
 * The denylist a sweeper reads. `onRevoked` is optional: without it (a test fake) the sweeper only
 * sweeps.
 */
export type RevocationSweeperDenylist = Pick<AccessTokenDenylist, 'enabled' | 'isDenied'> &
  Partial<Pick<AccessTokenDenylist, 'onRevoked'>>;

/**
 * Closes this replica's live WebSocket sessions whose access token was revoked (logout, tenant
 * switch, staff switch-out → denylist). A socket is authenticated once, at its handshake, so
 * without this a revoked token would keep receiving pushes until it expires. Each replica closes
 * its own sessions, so it works the same in every topology (the revoking call may run in another
 * service).
 *
 * Two paths. While started, it listens to the denylist's revocation channel
 * (`AccessTokenDenylist.onRevoked`) and ends a revoked token's sessions as the announcement
 * arrives, within a round trip. The timed sweep stays as the fallback for an announcement that
 * never arrives: a replica that only SETs the key (an older version), a failed publish, or a
 * subscriber that was reconnecting. A session is ended at most once, whichever path comes first.
 *
 * One `isDenied` per distinct jti per sweep. If the denylist cannot answer, every session is kept
 * until the next sweep (per-message guards still fail closed) and one warning is logged. Sweeps
 * never overlap. Transport-neutral: Socket.IO and graphql-ws each wrap their sockets as
 * `RevocableSession`s and untrack them when they close.
 */
export class RevocationSweeper {
  private readonly logger: Logger;
  private readonly sessions = new Set<RevocableSession>();
  private timer: NodeJS.Timeout | undefined;
  private unlisten: (() => void) | undefined;
  private sweeping = false;

  constructor(
    private readonly denylist: RevocationSweeperDenylist,
    private readonly options: RevocationSweeperOptions,
  ) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError(`intervalMs must be a positive integer, got ${options.intervalMs}`);
    }
    this.logger = new Logger(`RevocationSweeper(${options.name})`);
  }

  /** The number of tracked sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Registers a live session. The returned function removes it (idempotent); call it when the
   * socket closes. Each call registers its own entry, so sessions that share a jti are separate.
   */
  track(session: RevocableSession): () => void {
    const entry: RevocableSession = { jti: session.jti, end: () => session.end() };
    this.sessions.add(entry);
    return () => {
      this.sessions.delete(entry);
    };
  }

  /**
   * One `isDenied` per distinct jti; ends and untracks the denied sessions and resolves how many
   * were ended. Never overlaps itself (a second call while one is in flight resolves 0). A
   * denylist error keeps every session, logs one warning and resolves 0; a disabled denylist
   * resolves 0. Never rejects.
   */
  async sweep(): Promise<number> {
    if (this.sweeping || !this.denylist.enabled) return 0;
    this.sweeping = true;
    try {
      const byJti = new Map<string, RevocableSession[]>();
      for (const session of this.sessions) {
        byJti.set(session.jti, [...(byJti.get(session.jti) ?? []), session]);
      }
      const jtis = [...byJti.keys()];
      const denied = await Promise.all(jtis.map((jti) => this.denylist.isDenied(jti)));
      const revoked = jtis
        .filter((_, index) => denied[index] === true)
        .flatMap((jti) => byJti.get(jti) ?? []);
      // Untracked while the denylist answered: the socket already closed, or the channel ended it.
      const ended = this.endTracked(revoked);
      if (ended > 0) {
        this.logger.debug(`Closed ${ended} session(s) with a revoked access token`);
      }
      return ended;
    } catch (error) {
      this.logger.warn(
        `Revocation sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Listens to the revocation channel and sweeps every `intervalMs` on an unref'd timer.
   * Idempotent.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.intervalMs);
    this.timer.unref();
    this.unlisten = this.denylist.onRevoked?.((jti) => {
      this.revoke(jti);
    });
  }

  /** Stops listening and clears the interval. Tracked sessions stay open. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
  }

  /** Ends and untracks the sessions of `jti` announced on the revocation channel. */
  private revoke(jti: string): void {
    const ended = this.endTracked([...this.sessions].filter((session) => session.jti === jti));
    if (ended > 0) {
      this.logger.debug(`Closed ${ended} session(s) on a revocation announcement`);
    }
  }

  /** Untracks and ends each session still tracked; returns how many it ended. */
  private endTracked(sessions: readonly RevocableSession[]): number {
    let ended = 0;
    for (const session of sessions) {
      if (!this.sessions.delete(session)) continue;
      ended += 1;
      this.end(session);
    }
    return ended;
  }

  private end(session: RevocableSession): void {
    try {
      session.end();
    } catch (error) {
      this.logger.warn(
        `Ending a revoked session failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
