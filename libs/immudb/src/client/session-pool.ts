import { ImmudbError, isSessionGone, toImmudbError } from '../errors/immudb.error.js';
import type { ImmudbSession } from './immudb-session.js';

export interface PoolableSession {
  keepAlive(): Promise<void>;
  close(): Promise<void>;
}

/** Property-style members: they are passed unbound to `then` (no unbound-method). */
interface Waiter<TSession> {
  readonly resolve: (session: TSession) => void;
  readonly reject: (error: unknown) => void;
}

/** A failure after which the session must not be reused (expired, server gone). */
function poisons(error: unknown): boolean {
  if (error instanceof ImmudbError) return error.kind === 'unavailable';
  return isSessionGone(error) || toImmudbError(error)?.kind === 'unavailable';
}

/**
 * At most `size` sessions, opened lazily. Idle sessions get a `KeepAlive` every
 * `keepAliveIntervalMs` (the server drops sessions idle for 3 minutes); a session whose call or
 * keepalive failed with `unavailable` is closed and replaced, never returned to the pool.
 */
export class ImmudbSessionPool<TSession extends PoolableSession = ImmudbSession> {
  private readonly idle: TSession[] = [];
  private readonly waiting: Waiter<TSession>[] = [];
  private open = 0;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly factory: () => Promise<TSession>,
    private readonly size: number,
    keepAliveIntervalMs: number,
  ) {
    this.timer = setInterval(() => {
      void this.keepAliveIdle();
    }, keepAliveIntervalMs);
    this.timer.unref();
  }

  async use<T>(work: (session: TSession) => Promise<T>): Promise<T> {
    const session = await this.acquire();
    let healthy = true;
    try {
      return await work(session);
    } catch (error) {
      healthy = !poisons(error);
      throw error;
    } finally {
      this.release(session, healthy);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new ImmudbError('unavailable', 'immudb session pool is closed'));
    }
    await Promise.all(this.idle.splice(0).map((session) => this.discard(session)));
  }

  private async acquire(): Promise<TSession> {
    if (this.closed) throw new ImmudbError('unavailable', 'immudb session pool is closed');
    const idle = this.idle.pop();
    if (idle !== undefined) return idle;
    if (this.open < this.size) return this.openOne();
    return new Promise<TSession>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private async openOne(): Promise<TSession> {
    this.open++;
    try {
      return await this.factory();
    } catch (error) {
      this.open--;
      throw toImmudbError(error) ?? error;
    }
  }

  private release(session: TSession, healthy: boolean): void {
    if (healthy && !this.closed) {
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.idle.push(session);
      else waiter.resolve(session);
      return;
    }
    void this.discard(session);
    const waiter = this.waiting.shift();
    if (waiter !== undefined) this.openOne().then(waiter.resolve, waiter.reject);
  }

  private async discard(session: TSession): Promise<void> {
    this.open--;
    await session.close().catch(() => undefined);
  }

  private async keepAliveIdle(): Promise<void> {
    for (const session of [...this.idle]) {
      try {
        await session.keepAlive();
      } catch {
        const index = this.idle.indexOf(session);
        if (index >= 0) {
          this.idle.splice(index, 1);
          await this.discard(session);
        }
      }
    }
  }
}
