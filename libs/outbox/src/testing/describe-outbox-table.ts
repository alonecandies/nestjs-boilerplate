import { is, SQL } from 'drizzle-orm';
import { toSnakeCase } from 'drizzle-orm/casing';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

/** Every outbox table, column for column: name, SQL type, NOT NULL, SQL default. */
const OUTBOX_COLUMNS = [
  { name: 'tenant_id', type: 'uuid', notNull: true, default: null },
  { name: 'id', type: 'uuid', notNull: true, default: null },
  { name: 'topic', type: 'text', notNull: true, default: null },
  { name: 'key', type: 'text', notNull: false, default: null },
  { name: 'envelope', type: 'jsonb', notNull: true, default: null },
  { name: 'created_at', type: 'timestamp (3) with time zone', notNull: true, default: 'now()' },
  { name: 'published_at', type: 'timestamp (3) with time zone', notNull: false, default: null },
];

const OUTBOX_INDEXES = [
  {
    name: 'outbox_unpublished_idx',
    columns: ['created_at', 'id'],
    where: '"published_at" IS NULL',
    unique: false,
  },
  {
    name: 'outbox_published_at_idx',
    columns: ['published_at'],
    where: '"published_at" IS NOT NULL',
    unique: false,
  },
];

/**
 * The shape spec every domain's schema spec calls on its hand-declared outbox table:
 * `describeOutboxTable(outbox, 'orders')`. It pins the table `<schema>.outbox` with exactly the
 * columns of the outbox table (names under `casing: 'snake_case'`, types, nullability, defaults),
 * the primary key `outbox_tenant_id_id_pk (tenant_id, id)`, the two partial indexes, and no foreign
 * key, unique constraint, check or drizzle policy (policies live in the hand-edited migration).
 */
export function describeOutboxTable(table: unknown, schema: string): void {
  describe(`outbox table "${schema}.outbox"`, () => {
    const dialect = new PgDialect({ casing: 'snake_case' });
    const config = () => {
      expect(is(table, PgTable)).toBe(true);
      return getTableConfig(table as PgTable);
    };
    /** A column's SQL name under `casing: 'snake_case'` (table and index columns alike). */
    const columnName = (column: unknown): string => {
      if (is(column, SQL)) return dialect.sqlToQuery(column).sql;
      const { name, keyAsName } = column as { name?: string; keyAsName?: boolean };
      return keyAsName === true ? toSnakeCase(name ?? '') : (name ?? '');
    };
    const unqualified = (where: string) =>
      where.replaceAll(`"${schema}"."outbox".`, '').replaceAll('"outbox".', '');

    it('is the table "outbox" of the schema', () => {
      const { name, schema: pgSchema } = config();
      expect({ name, schema: pgSchema }).toEqual({ name: 'outbox', schema });
    });

    it('has exactly the outbox columns', () => {
      const columns = config().columns.map((column) => ({
        name: columnName(column),
        type: column.getSQLType(),
        notNull: column.notNull,
        default:
          column.default === undefined
            ? null
            : dialect.sqlToQuery(column.default as Parameters<typeof dialect.sqlToQuery>[0]).sql,
      }));
      expect(columns).toEqual(OUTBOX_COLUMNS);
    });

    it('has the primary key (tenant_id, id) and the two partial indexes, nothing else', () => {
      const { primaryKeys, indexes, foreignKeys, uniqueConstraints, checks, policies } = config();
      expect(
        primaryKeys.map((key) => ({
          name: key.getName(),
          columns: key.columns.map(columnName),
        })),
      ).toEqual([{ name: 'outbox_tenant_id_id_pk', columns: ['tenant_id', 'id'] }]);
      expect(
        indexes.map(({ config: index }) => ({
          name: index.name,
          columns: index.columns.map(columnName),
          where:
            index.where === undefined ? null : unqualified(dialect.sqlToQuery(index.where).sql),
          unique: index.unique,
        })),
      ).toEqual(OUTBOX_INDEXES);
      expect({
        foreignKeys: foreignKeys.length,
        uniqueConstraints: uniqueConstraints.length,
        checks: checks.length,
        policies: policies.length,
      }).toEqual({ foreignKeys: 0, uniqueConstraints: 0, checks: 0, policies: 0 });
    });
  });
}
