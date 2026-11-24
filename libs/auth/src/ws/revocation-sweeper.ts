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
 * Three paths. While started, it listens to the denylist's revocation channel
 * (`AccessTokenDenylist.onRevoked`) and ends a revoked token's sessions as the announcement
 * arrives, within a round trip. `track()` registers a session and then checks its jti once, so a
 * token revoked during the handshake (after its own denylist check, before `track()`, when no
 * announcement can find the session) is ended as that check answers: tracked first, then
 * checked, so a revocation is seen by the check or by the announcement. The timed sweep stays as
 * the fallback for an announcement that never arrives: a replica that only SETs the key (an older
 * version), a failed publish, or a subscriber that was reconnecting. A session is ended at most
 * once, whichever path comes first.
 *
 * Sessions are indexed by jti, so an announcement reads one entry. One `isDenied` per tracked
 * session and one per distinct jti per sweep. If the denylist cannot answer, the session (or, for
 * a sweep, every session) is kept until the next sweep (per-message guards still fail closed) and
 * one warning is logged. Sweeps never overlap. Transport-neutral: Socket.IO and graphql-ws each
 * wrap their sockets as `RevocableSession`s and untrack them when they close.
 */
export class RevocationSweeper {
  private readonly logger: Logger;
  /** The tracked sessions by jti; a jti's entry is removed with its last session. */
  private readonly byJti = new Map<string, Set<RevocableSession>>();
  private tracked = 0;
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
    return this.tracked;
  }

  /**
   * Registers a live session, then starts one `isDenied` for its jti (none while the denylist is
   * disabled) and ends it if that answers "denied". The returned function removes it
   * (idempotent); call it when the socket closes. Each call registers its own entry, so sessions
   * that share a jti are separate and each is checked. Never ends the session before it returns.
   */
  track(session: RevocableSession): () => void {
    const entry: RevocableSession = { jti: session.jti, end: () => session.end() };
    const sessions = this.byJti.get(entry.jti);
    if (sessions === undefined) {
      this.byJti.set(entry.jti, new Set([entry]));
    } else {
      sessions.add(entry);
    }
    this.tracked += 1;
    // Only after the entry is tracked: a revocation from here on is seen by this check or by the
    // announcement, whichever comes first.
    if (this.denylist.enabled) void this.check(entry);
    return () => {
      this.untrack(entry);
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
      // A snapshot: sessions tracked while the denylist answers were checked by their own track().
      const snapshot = [...this.byJti].map(([jti, sessions]) => ({ jti, sessions: [...sessions] }));
      const denied = await Promise.all(snapshot.map(({ jti }) => this.denylist.isDenied(jti)));
      const revoked = snapshot
        .filter((_, index) => denied[index] === true)
        .flatMap(({ sessions }) => sessions);
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
    const ended = this.endTracked([...(this.byJti.get(jti) ?? [])]);
    if (ended > 0) {
      this.logger.debug(`Closed ${ended} session(s) on a revocation announcement`);
    }
  }

  /**
   * The check `track()` starts: ends the session if its jti is denied and it is still tracked. A
   * denylist error leaves it to the sweep and logs one warning. Never rejects.
   */
  private async check(session: RevocableSession): Promise<void> {
    try {
      if (!(await this.denylist.isDenied(session.jti))) return;
    } catch (error) {
      this.logger.warn(
        `Revocation check after tracking skipped (the sweep retries): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (this.endTracked([session]) > 0) {
      this.logger.debug('Closed a session whose access token was revoked during its handshake');
    }
  }

  /** Untracks and ends each session still tracked; returns how many it ended. */
  private endTracked(sessions: readonly RevocableSession[]): number {
    let ended = 0;
    for (const session of sessions) {
      if (!this.untrack(session)) continue;
      ended += 1;
      this.end(session);
    }
    return ended;
  }

  /** Removes a tracked session; false when it was not tracked (already ended or untracked). */
  private untrack(session: RevocableSession): boolean {
    const sessions = this.byJti.get(session.jti);
    if (sessions?.delete(session) !== true) return false;
    if (sessions.size === 0) this.byJti.delete(session.jti);
    this.tracked -= 1;
    return true;
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
