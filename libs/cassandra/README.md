# @app/cassandra

Apache Cassandra through `cassandra-driver` 4.10. It provides a global `CassandraModule` with a tuned,
keyspace-bound client (prepared statements and a configured consistency by default), **keyspace bootstrap** and
**LWT-claimed CQL migrations** at boot, driver-native paging (`executePage`), and a readiness contributor.

## Public API

| Export                                                                                                                                          | Kind            | Purpose                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CassandraModule.forRootAsync(options?: CassandraModuleOptions): DynamicModule`                                                                 | module (global) | Bootstrap → migrate → connected client, health indicator, shutdown                                                         |
| `CassandraModuleOptions`                                                                                                                        | interface       | `{ migrations?: CassandraMigrationSource[]; runMigrations?; replication?: CassandraReplication; migrationLockTimeoutMs? }` |
| `CassandraMigrationSource`                                                                                                                      | interface       | `{ dir: string }`, a folder of `NNN_name.cql` files                                                                        |
| `CassandraReplication`                                                                                                                          | type            | `{ class: 'SimpleStrategy'; replicationFactor }` \| `{ class: 'NetworkTopologyStrategy'; dataCenters: Record<dc, rf> }`    |
| `CASSANDRA_CLIENT`, `CASSANDRA_MODULE_OPTIONS`                                                                                                  | symbols         | Injection tokens                                                                                                           |
| `InjectCassandra()`                                                                                                                             | decorator       | `@InjectCassandra() private readonly client: CassandraClient`                                                              |
| `CassandraClient`, `CqlParams`                                                                                                                  | types           | `cassandra.Client`, positional or named bind params                                                                        |
| `executePage<T>(client, cql, params, { fetchSize, pageState?, mapRow, queryOptions? }): Promise<CassandraPage<T>>`                              | fn              | One prepared page → `{ items, pageState: string \| null }`                                                                 |
| `ExecutePageOptions<T>`, `CassandraPage<T>`, `MAX_FETCH_SIZE` (5000), `MAX_PAGE_STATE_LENGTH`                                                   | types, consts   | A bad page state is a 422 `INVALID_PAGE_STATE`                                                                             |
| `CqlMigrator` (`new CqlMigrator(client, options).run(): Promise<CqlMigrationSummary>`)                                                          | class           | Forward-only runner, one LWT claim per version                                                                             |
| `loadCqlMigrations(sources): CqlMigration[]`, `splitCqlStatements(script): string[]`                                                            | fns             | File discovery, ordering and validation; a statement splitter that understands quotes, comments and `$$`                   |
| `CqlMigration`, `CqlMigratorOptions`, `CqlMigrationSummary`, `CQL_MIGRATIONS_TABLE`                                                             | types, const    | `<keyspace>.schema_migrations`                                                                                             |
| `CassandraHealthIndicator`                                                                                                                      | provider        | `HealthContributor` with key `cassandra` (`SELECT release_version FROM system.local`, 2 s)                                 |
| `buildClientOptions(cfg, ctx)`, `toConsistency(name)`, `createKeyspaceCql(ks, replication)`, `replicationToCql(r)`, `assertCqlIdentifier(name)` | fns             | Driver options and DDL builders (validated)                                                                                |
| `createCassandraClient(cfg, app, options, logger?)`                                                                                             | fn              | The factory behind `CASSANDRA_CLIENT`                                                                                      |
| `DEFAULT_FETCH_SIZE` (100)                                                                                                                      | const           | Default page size (the driver's own default is 5000)                                                                       |

## Usage

```ts
// notifications lib: migrations shipped next to the code (SWC copyFiles copies .cql to dist)
export const notificationsCassandraMigrations = { dir: join(import.meta.dirname, 'migrations') };

// app.module.ts
CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] }),
ObservabilityModule.forRoot({ healthContributors: [CassandraHealthIndicator] }),

// repository
@Injectable()
export class NotificationsRepository {
  constructor(@InjectCassandra() private readonly client: CassandraClient) {}

  list(userId: string, limit: number, pageState?: string) {
    return executePage(this.client, 'SELECT * FROM notifications_by_user WHERE user_id = ?', [userId], {
      fetchSize: limit,
      pageState,
      mapRow: toNotification,
    });
  }
}
```

A migration file, e.g. `001_create_notifications.cql`, may contain several statements, and each must be
idempotent:

```sql
CREATE TABLE IF NOT EXISTS notifications_by_user (...) WITH CLUSTERING ORDER BY (notification_id DESC);
-- `{keyspace}` is substituted if you prefer fully-qualified names: CREATE TABLE IF NOT EXISTS {keyspace}.t (...)
```

## Boot sequence (when `CASSANDRA_RUN_MIGRATIONS=true`, the default)

1. A short-lived client **without a keyspace** runs `CREATE KEYSPACE IF NOT EXISTS` (SimpleStrategy with
   `CASSANDRA_REPLICATION_FACTOR`, or the `replication` option) and shuts down. It never alters an existing
   keyspace.
2. The main client binds to the keyspace and connects eagerly, retrying transient `NoHostAvailableError` and
   timeouts with a fresh client each time.
3. `CqlMigrator` reads `schema_migrations` (applied versions cost no LWT) and claims each pending version with
   `INSERT … IF NOT EXISTS`. The winner applies it and flips `status` to `applied`; other replicas wait for that.
   A failed migration releases its claim and aborts boot. Editing an applied file only logs a warning, because
   applied files are never re-run.

## Environment (`cassandra` namespace, plus `SERVICE_NAME`)

`CASSANDRA_CONTACT_POINTS` (localhost), `CASSANDRA_PORT` (9042), `CASSANDRA_LOCAL_DC` (datacenter1),
`CASSANDRA_KEYSPACE` (app), `CASSANDRA_USERNAME`/`CASSANDRA_PASSWORD`, `CASSANDRA_REPLICATION_FACTOR` (1),
`CASSANDRA_CONSISTENCY` (localOne: localOne|localQuorum|quorum|one), `CASSANDRA_CORE_CONNECTIONS` (2 per local host),
`CASSANDRA_REQUEST_TIMEOUT_MS` (12000 → `socketOptions.readTimeout`), `CASSANDRA_RUN_MIGRATIONS` (true).

## Gotchas

- **Policies are built per client.** A load-balancing or reconnection policy object binds to the first `Client`,
  and a second client sharing it fails every query with "No connection available". `buildClientOptions` is
  therefore called once per client.
- The driver runs **one statement per `execute()`**. `splitCqlStatements` splits files safely, ignoring `;` inside
  strings, quoted identifiers, comments and `$$` bodies.
- `queryOptions.prepare` defaults to `false` in the driver. We set it to `true` everywhere, and `executePage` always
  prepares. DDL is sent unprepared on purpose.
- `CASSANDRA_LOCAL_DC` must match `nodetool status`, or the driver ignores every node.
- A page state is only valid for the same query and params. Hitting a partition end exactly on a page boundary
  yields one extra empty page with a `null` state.
- Batch only rows of the **same partition**. For bulk writes across partitions, use `concurrent.executeConcurrent`.
- Use `NetworkTopologyStrategy` (`replication` option) for multi-DC production. Changing replication later
  needs a manual `ALTER KEYSPACE` plus a repair.
- A crashed instance can leave a claim stuck in `applying`. Boot then times out after `migrationLockTimeoutMs`
  (2 min) and prints the `DELETE` that releases it.
