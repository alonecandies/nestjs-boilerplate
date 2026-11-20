import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIGRATIONS_TABLE } from '@platform/database';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { aiMigrations } from './ai.migrations.js';
import {
  aiPgSchema,
  aiSchema,
  conversations,
  messageRoleEnum,
  messageStatusEnum,
  messages,
  usage,
  usageOutcomeEnum,
} from './ai.schema.js';

/** A migration file's statements: comments dropped, whitespace collapsed, one entry per breakpoint. */
const statementsOf = (file: string): string[] =>
  readFileSync(join(aiMigrations.folder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((statement) => statement !== '');

const journalTags = (): string[] =>
  (
    JSON.parse(readFileSync(join(aiMigrations.folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    }
  ).entries.map((entry) => entry.tag);

const TABLES = ['conversations', 'messages', 'usage'] as const;
/** The owner predicate of every policy: row-local, the platform helpers called directly. */
const OWNER = 'tenant_id = app.tenant_id() AND user_id = app.user_id()';

describe('aiMigrations', () => {
  it("is ai's own history: ./migrations, bookkeeping in ai.__drizzle_migrations", () => {
    expect(aiMigrations).toEqual({
      name: 'ai',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'ai',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every ai table and enum in the ai Postgres schema', () => {
    expect(aiPgSchema.schemaName).toBe(aiMigrations.migrationsSchema);
    const tables = [conversations, messages, usage];
    expect(tables.map((table) => getTableConfig(table).schema)).toEqual(tables.map(() => 'ai'));
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([...TABLES]);
    for (const enumeration of [messageRoleEnum, messageStatusEnum, usageOutcomeEnum]) {
      expect(enumeration.schema).toBe('ai');
    }
  });

  it('registers the tables under ai-prefixed keys: the monolith spreads every schema into one object', () => {
    expect(aiSchema.aiConversations).toBe(conversations);
    expect(aiSchema.aiMessages).toBe(messages);
    expect(aiSchema.aiUsage).toBe(usage);
    expect(Object.keys(aiSchema)).not.toEqual(expect.arrayContaining(['messages']));
    expect(Object.keys(aiSchema)).not.toEqual(expect.arrayContaining(['usage']));
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(aiMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([aiMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: aiMigrations.migrationsSchema,
      table: aiMigrations.migrationsTable,
    });
  });

  describe('0000_init (a fresh baseline in the sharding design order)', () => {
    const statements = (): string[] => statementsOf('0000_init.sql');
    /** The statement index of each `CREATE TABLE`, by table name. */
    const creates = (): [string, number][] =>
      statements()
        .map((statement, index) => [statement.match(/^CREATE TABLE "ai"\."(\w+)"/)?.[1], index])
        .filter((entry): entry is [string, number] => entry[0] !== undefined);
    const firstIndexOf = (pattern: RegExp): number =>
      statements().findIndex((statement) => pattern.test(statement));

    it('is the only journal entry, with one snapshot', () => {
      expect(journalTags()).toEqual(['0000_init']);
      expect(readdirSync(join(aiMigrations.folder, 'meta')).toSorted()).toEqual([
        '0000_snapshot.json',
        '_journal.json',
      ]);
    });

    it('creates its schema idempotently first (the migrator creates it for the bookkeeping table)', () => {
      expect(statements()[0]).toBe('CREATE SCHEMA IF NOT EXISTS "ai";');
      expect(statements().join('\n')).not.toMatch(/CREATE SCHEMA "ai";/);
    });

    it('creates the three enums with every value of the domain lists', () => {
      expect(statements().filter((statement) => statement.startsWith('CREATE TYPE'))).toEqual([
        `CREATE TYPE "ai"."message_role" AS ENUM('system', 'user', 'assistant', 'tool');`,
        `CREATE TYPE "ai"."message_status" AS ENUM('complete', 'incomplete');`,
        `CREATE TYPE "ai"."usage_outcome" AS ENUM('success', 'error', 'timeout', 'aborted');`,
      ]);
    });

    it('creates the tables tenant-first: tenant-leading keys, no column default for tenant_id', () => {
      const text = statements().join('\n');
      for (const table of TABLES) {
        expect(text).toContain(
          `CONSTRAINT "${table}_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")`,
        );
      }
      expect(text).toContain(
        'CREATE INDEX "conversations_tenant_id_user_id_id_idx" ON "ai"."conversations" USING btree ("tenant_id","user_id","id");',
      );
      expect(text).toContain(
        'CREATE INDEX "messages_tenant_id_conversation_id_id_idx" ON "ai"."messages" USING btree ("tenant_id","conversation_id","id");',
      );
      expect(text).toContain(
        'CREATE UNIQUE INDEX "messages_tenant_id_conversation_id_idempotency_key_uq" ON "ai"."messages" USING btree ("tenant_id","conversation_id","idempotency_key");',
      );
      expect(text).toContain(
        'CREATE INDEX "usage_tenant_id_user_id_id_idx" ON "ai"."usage" USING btree ("tenant_id","user_id","id");',
      );
      expect(text).toContain('"cost_usd" numeric(14, 8),');
      expect(text).not.toMatch(/"tenant_id" uuid DEFAULT/);
    });

    it('copies the owner onto every row: user_id NOT NULL on all three tables', () => {
      for (const [table, index] of creates()) {
        expect(statements()[index], table).toContain('"user_id" uuid NOT NULL');
      }
    });

    it('distributes each table by tenant right after its CREATE', () => {
      expect(creates().map(([table]) => table)).toEqual([...TABLES]);
      expect(statements().filter((statement) => /^SELECT app\./.test(statement))).toEqual(
        TABLES.map((table) => `SELECT app.distribute_by_tenant('ai.${table}');`),
      );
      for (const [table, index] of creates()) {
        expect(statements()[index + 1]).toBe(`SELECT app.distribute_by_tenant('ai.${table}');`);
      }
    });

    it('creates every table, distribution and index before the RLS, grants, then policies', () => {
      const lastStructural = statements().findLastIndex((statement) =>
        /^(CREATE TYPE|CREATE TABLE|CREATE (UNIQUE )?INDEX|SELECT app\.)/.test(statement),
      );
      const rls = firstIndexOf(/ROW LEVEL SECURITY;$/);
      const grants = firstIndexOf(/^GRANT /);
      const policies = firstIndexOf(/^CREATE POLICY /);
      expect(lastStructural).toBeLessThan(rls);
      expect(rls).toBeLessThan(grants);
      expect(grants).toBeLessThan(policies);
      expect(statements().at(-1)).toMatch(/^CREATE POLICY /);
    });

    it('adds no foreign key, no default privilege, no REVOKE and nothing for PUBLIC', () => {
      const text = statements().join('\n');
      expect(text).not.toMatch(/FOREIGN KEY|REFERENCES/i);
      expect(text).not.toMatch(/DEFAULT PRIVILEGES|\bREVOKE\b|\bPUBLIC\b|__drizzle_migrations/i);
    });

    it('enables and forces RLS on all three tables, one table per statement', () => {
      expect(statements().filter((statement) => /ROW LEVEL SECURITY;$/.test(statement))).toEqual(
        TABLES.flatMap((table) => [
          `ALTER TABLE ai.${table} ENABLE ROW LEVEL SECURITY;`,
          `ALTER TABLE ai.${table} FORCE ROW LEVEL SECURITY;`,
        ]),
      );
    });

    it('grants one table (or schema) to the runtime role per statement; usage is insert-only', () => {
      expect(statements().filter((statement) => /^(GRANT|REVOKE)\b/.test(statement))).toEqual([
        'GRANT USAGE ON SCHEMA ai TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai.conversations TO app_runtime;',
        'GRANT SELECT, INSERT, DELETE ON TABLE ai.messages TO app_runtime;',
        'GRANT SELECT, INSERT ON TABLE ai.usage TO app_runtime;',
      ]);
    });

    it('holds exactly the owner policies, row-local (no subquery, CASE or IS NULL)', () => {
      const policies = statements().filter((statement) => statement.startsWith('CREATE POLICY'));
      expect(policies).toEqual([
        `CREATE POLICY conversations_select ON ai.conversations FOR SELECT TO app_runtime USING (${OWNER});`,
        `CREATE POLICY conversations_insert ON ai.conversations FOR INSERT TO app_runtime WITH CHECK (${OWNER});`,
        `CREATE POLICY conversations_update ON ai.conversations FOR UPDATE TO app_runtime USING (${OWNER}) WITH CHECK (${OWNER});`,
        `CREATE POLICY conversations_delete ON ai.conversations FOR DELETE TO app_runtime USING (${OWNER});`,
        `CREATE POLICY messages_select ON ai.messages FOR SELECT TO app_runtime USING (${OWNER});`,
        `CREATE POLICY messages_insert ON ai.messages FOR INSERT TO app_runtime WITH CHECK (${OWNER});`,
        `CREATE POLICY messages_delete ON ai.messages FOR DELETE TO app_runtime USING (${OWNER});`,
        `CREATE POLICY usage_select ON ai.usage FOR SELECT TO app_runtime USING (${OWNER});`,
        `CREATE POLICY usage_insert ON ai.usage FOR INSERT TO app_runtime WITH CHECK (${OWNER});`,
      ]);
      for (const policy of policies) {
        expect(policy).not.toMatch(/\(\s*select/i);
        expect(policy).not.toMatch(/\bCASE\b|\bIS NULL\b|app\.elevated/i);
      }
    });
  });
});
