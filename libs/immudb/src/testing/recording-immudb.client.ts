import { ImmudbClient } from '../client/immudb.client.js';
import { ImmudbError } from '../errors/immudb.error.js';
import type {
  ImmudbParams,
  ImmudbRow,
  ImmudbState,
  ImmudbTx,
  ImmudbValue,
} from '../immudb.types.js';

export interface RecordedStatement {
  readonly mode: 'readWrite' | 'readOnly';
  readonly kind: 'exec' | 'query' | 'verify';
  readonly sql: string;
  readonly params: ImmudbParams;
}

/**
 * Unit-test `ImmudbClient`: records every statement and answers queries with `respond`. Pins the
 * SQL an adapter sends (tenant predicates, parameter binding) without a server.
 */
export class RecordingImmudbClient extends ImmudbClient {
  readonly statements: RecordedStatement[] = [];
  private nextTxId = 1n;

  constructor(private readonly respond: (statement: RecordedStatement) => ImmudbRow[] = () => []) {
    super();
  }

  override async readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }> {
    let wrote = false;
    const result = await work(this.tx('readWrite', () => (wrote = true)));
    return { result, txId: wrote ? this.nextTxId++ : null };
  }

  override readOnly<T>(work: (tx: ImmudbTx) => Promise<T>): Promise<T> {
    return work(this.tx('readOnly', () => undefined));
  }

  override async currentState(): Promise<ImmudbState> {
    return {
      database: 'test',
      txId: this.nextTxId - 1n,
      txHash: new Uint8Array(32),
      signature: null,
    };
  }

  override async verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void> {
    const statement = {
      mode: 'readOnly',
      kind: 'verify',
      sql: 'verifyConsistency',
      params: { trustedTxId: trusted.txId, targetTxId: target.txId },
    } as const;
    this.statements.push(statement);
    this.respond(statement);
  }

  /** Answers with the first row `respond` returns for `verifiedRow <table>` (params `pk0`, `pk1`, ...). */
  override async verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }> {
    const statement = {
      mode: 'readOnly',
      kind: 'verify',
      sql: `verifiedRow ${table}`,
      params: Object.fromEntries(pk.map((value, i) => [`pk${i}`, value])),
    } as const;
    this.statements.push(statement);
    const [row] = this.respond(statement);
    if (row === undefined)
      throw new ImmudbError('verification-failed', `no scripted row in ${table}`);
    return { row, txId: trusted.txId, state: trusted };
  }

  private tx(mode: RecordedStatement['mode'], onExec: () => void): ImmudbTx {
    return {
      exec: async (sql: string, params: ImmudbParams = {}): Promise<void> => {
        onExec();
        const statement = { mode, kind: 'exec', sql, params } as const;
        this.statements.push(statement);
        this.respond(statement);
      },
      query: async <T extends Record<string, ImmudbValue>>(
        sql: string,
        params: ImmudbParams = {},
      ): Promise<T[]> => {
        const statement = { mode, kind: 'query', sql, params } as const;
        this.statements.push(statement);
        return this.respond(statement) as T[];
      },
    };
  }
}
