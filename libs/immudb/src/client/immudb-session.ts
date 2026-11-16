import { Metadata } from '@grpc/grpc-js';
import type { Empty } from '../generated/google/protobuf/empty.pb.js';
import {
  ChangePermissionRequest,
  ChangeSQLPrivilegesRequest,
  type ChangeSQLPrivilegesResponse,
  type CommittedSQLTx,
  CreateDatabaseRequest,
  type CreateDatabaseResponse,
  CreateUserRequest,
  type HealthResponse,
  type ImmuServiceClient,
  type ImmutableState,
  NewTxRequest,
  type NewTxResponse,
  OpenSessionRequest,
  type OpenSessionResponse,
  PermissionAction,
  SQLExecRequest,
  type SQLExecResult,
  SQLQueryRequest,
  type SQLQueryResult,
  type TxMode,
  type VerifiableSQLEntry,
  VerifiableSQLGetRequest,
  type VerifiableTx,
  VerifiableTxRequest,
} from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbRow, ImmudbValue } from '../immudb.types.js';
import { drain, type ServerStreamMethod, type UnaryMethod, unary } from './grpc-call.js';
import { rowsOf, toNamedParams, toSqlValue } from './sql-values.js';

export interface ImmudbLogin {
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/** CreateUser permission: 1 read, 2 read-write, 254 admin. SQL privileges are narrowed afterwards. */
const PERMISSION_READ_WRITE = 2;

/**
 * One immudb session (`OpenSession`, metadata `sessionid`). A session runs at most one
 * transaction at a time (metadata `transactionid`). Every RPC is wrapped in a lambda so the
 * generated client's methods are never referenced unbound.
 */
export class ImmudbSession {
  private constructor(
    private readonly client: ImmuServiceClient,
    readonly id: string,
    private readonly timeoutMs: number,
  ) {}

  static async open(
    client: ImmuServiceClient,
    login: ImmudbLogin,
    timeoutMs: number,
  ): Promise<ImmudbSession> {
    const response = await unary<OpenSessionRequest, OpenSessionResponse>(
      (r, m, o, cb) => client.openSession(r, m, o, cb),
      OpenSessionRequest.fromPartial({
        username: Buffer.from(login.username),
        password: Buffer.from(login.password),
        databaseName: login.database,
      }),
      new Metadata(),
      timeoutMs,
    );
    return new ImmudbSession(client, response.sessionID, timeoutMs);
  }

  private metadata(transactionId?: string): Metadata {
    const metadata = new Metadata();
    metadata.set('sessionid', this.id);
    if (transactionId !== undefined) metadata.set('transactionid', transactionId);
    return metadata;
  }

  private call<TReq, TRes>(
    method: UnaryMethod<TReq, TRes>,
    request: TReq,
    transactionId?: string,
  ): Promise<TRes> {
    return unary(method, request, this.metadata(transactionId), this.timeoutMs);
  }

  async keepAlive(): Promise<void> {
    await this.call<Empty, Empty>((r, m, o, cb) => this.client.keepAlive(r, m, o, cb), {});
  }

  async close(): Promise<void> {
    await this.call<Empty, Empty>((r, m, o, cb) => this.client.closeSession(r, m, o, cb), {});
  }

  health(): Promise<HealthResponse> {
    return this.call<Empty, HealthResponse>((r, m, o, cb) => this.client.health(r, m, o, cb), {});
  }

  async newTx(mode: TxMode, mustIncludeTxId?: bigint): Promise<string> {
    const response = await this.call<NewTxRequest, NewTxResponse>(
      (r, m, o, cb) => this.client.newTx(r, m, o, cb),
      NewTxRequest.fromPartial({
        mode,
        snapshotMustIncludeTxID:
          mustIncludeTxId === undefined ? undefined : { value: mustIncludeTxId.toString() },
      }),
    );
    return response.transactionID;
  }

  commit(transactionId: string): Promise<CommittedSQLTx> {
    return this.call<Empty, CommittedSQLTx>(
      (r, m, o, cb) => this.client.commit(r, m, o, cb),
      {},
      transactionId,
    );
  }

  async rollback(transactionId: string): Promise<void> {
    await this.call<Empty, Empty>(
      (r, m, o, cb) => this.client.rollback(r, m, o, cb),
      {},
      transactionId,
    );
  }

  async txExec(transactionId: string, sql: string, params?: ImmudbParams): Promise<void> {
    await this.call<SQLExecRequest, Empty>(
      (r, m, o, cb) => this.client.txSqlExec(r, m, o, cb),
      SQLExecRequest.fromPartial({ sql, params: toNamedParams(params) }),
      transactionId,
    );
  }

  txQueryRaw(transactionId: string, sql: string, params?: ImmudbParams): Promise<SQLQueryResult[]> {
    const method: ServerStreamMethod<SQLQueryRequest, SQLQueryResult> = (r, m, o) =>
      this.client.txSqlQuery(r, m, o);
    return drain(
      method,
      SQLQueryRequest.fromPartial({ sql, params: toNamedParams(params) }),
      this.metadata(transactionId),
      this.timeoutMs,
    );
  }

  async txQuery(transactionId: string, sql: string, params?: ImmudbParams): Promise<ImmudbRow[]> {
    return rowsOf(await this.txQueryRaw(transactionId, sql, params));
  }

  /** `SQLExec`: statements in their own server transaction, committed on success (DDL, provisioning). */
  async exec(sql: string, params?: ImmudbParams): Promise<void> {
    await this.call<SQLExecRequest, SQLExecResult>(
      (r, m, o, cb) => this.client.sqlExec(r, m, o, cb),
      SQLExecRequest.fromPartial({ sql, params: toNamedParams(params) }),
    );
  }

  currentState(): Promise<ImmutableState> {
    return this.call<Empty, ImmutableState>(
      (r, m, o, cb) => this.client.currentState(r, m, o, cb),
      {},
    );
  }

  verifiableTxById(tx: bigint, proveSinceTx: bigint): Promise<VerifiableTx> {
    return this.call<VerifiableTxRequest, VerifiableTx>(
      (r, m, o, cb) => this.client.verifiableTxById(r, m, o, cb),
      VerifiableTxRequest.fromPartial({ tx: tx.toString(), proveSinceTx: proveSinceTx.toString() }),
    );
  }

  verifiableSqlGet(
    table: string,
    pk: readonly ImmudbValue[],
    proveSinceTx: bigint,
  ): Promise<VerifiableSQLEntry> {
    return this.call<VerifiableSQLGetRequest, VerifiableSQLEntry>(
      (r, m, o, cb) => this.client.verifiableSqlGet(r, m, o, cb),
      VerifiableSQLGetRequest.fromPartial({
        sqlGetRequest: { table, pkValues: pk.map(toSqlValue) },
        proveSinceTx: proveSinceTx.toString(),
      }),
    );
  }

  async createDatabase(name: string): Promise<void> {
    await this.call<CreateDatabaseRequest, CreateDatabaseResponse>(
      (r, m, o, cb) => this.client.createDatabaseV2(r, m, o, cb),
      CreateDatabaseRequest.fromPartial({ name, ifNotExists: true }),
    );
  }

  async createUser(username: string, password: string, database: string): Promise<void> {
    await this.call<CreateUserRequest, Empty>(
      (r, m, o, cb) => this.client.createUser(r, m, o, cb),
      CreateUserRequest.fromPartial({
        user: Buffer.from(username),
        password: Buffer.from(password),
        permission: PERMISSION_READ_WRITE,
        database,
      }),
    );
  }

  /** Gives an existing user read-write permission on `database` (a no-op when it has it). */
  async grantReadWrite(username: string, database: string): Promise<void> {
    await this.call<ChangePermissionRequest, Empty>(
      (r, m, o, cb) => this.client.changePermission(r, m, o, cb),
      ChangePermissionRequest.fromPartial({
        action: PermissionAction.GRANT,
        username,
        database,
        permission: PERMISSION_READ_WRITE,
      }),
    );
  }

  async revokeSqlPrivileges(
    username: string,
    database: string,
    privileges: readonly string[],
  ): Promise<void> {
    await this.call<ChangeSQLPrivilegesRequest, ChangeSQLPrivilegesResponse>(
      (r, m, o, cb) => this.client.changeSqlPrivileges(r, m, o, cb),
      ChangeSQLPrivilegesRequest.fromPartial({
        action: PermissionAction.REVOKE,
        username,
        database,
        privileges: [...privileges],
      }),
    );
  }
}
