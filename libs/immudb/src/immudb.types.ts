/** A value bound to or read from immudb SQL. `bigint` = INTEGER (int64); `Date` = TIMESTAMP (µs). */
export type ImmudbValue = null | string | bigint | boolean | Uint8Array | Date;
/** Named parameters: `{ id: 'x' }` binds `@id`. */
export type ImmudbParams = Readonly<Record<string, ImmudbValue>>;
/** One result row keyed by column name (aliases for computed columns: `SUM(x) AS total`). */
export type ImmudbRow = Record<string, ImmudbValue>;

/** Statements inside one server-side transaction. */
export interface ImmudbTx {
  exec(sql: string, params?: ImmudbParams): Promise<void>;
  /** Row shapes must be `type` aliases (interfaces have no index signature). */
  query<T extends Record<string, ImmudbValue>>(sql: string, params?: ImmudbParams): Promise<T[]>;
}

/** The server's current state of one database (`CurrentState`). */
export interface ImmudbState {
  readonly database: string;
  readonly txId: bigint;
  /** Alh (accumulative linear hash) of `txId`, 32 bytes. */
  readonly txHash: Uint8Array;
  /** ECDSA (P-256, SHA-256, ASN.1 DER) over the state, when the server runs with --signingKey. */
  readonly signature: Uint8Array | null;
}

/** A folder of versioned `NNN_name.sql` files, applied in order by `runImmudbMigrations`. */
export interface ImmudbMigrationSource {
  readonly name: string;
  readonly dir: string;
}

export interface ImmudbModuleOptions {
  /** Applied at boot when IMMUDB_RUN_MIGRATIONS=true (needs IMMUDB_ADMIN_PASSWORD). */
  readonly migrations?: readonly ImmudbMigrationSource[];
}
