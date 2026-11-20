import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { MIGRATIONS_TABLE } from '@platform/database';
import { describeOutboxTable } from '@platform/outbox/testing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { identityMigrations } from './identity.migrations.js';
import {
  auditEvents,
  identityPgSchema,
  invitations,
  memberships,
  outbox,
  sessions,
  tenantRole,
  tenants,
  users,
} from './identity.schema.js';

describeOutboxTable(outbox, 'identity');

describe('identityMigrations', () => {
  it("is identity's own history: ./migrations, bookkeeping in identity.__drizzle_migrations", () => {
    expect(identityMigrations).toEqual({
      name: 'identity',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'identity',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every identity table and enum in the identity Postgres schema', () => {
    expect(identityPgSchema.schemaName).toBe(identityMigrations.migrationsSchema);
    expect(
      [users, sessions, tenants, memberships, invitations, auditEvents, outbox].map(
        (table) => getTableConfig(table).schema,
      ),
    ).toEqual(Array(7).fill('identity'));
    expect(tenantRole.schema).toBe('identity');
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(identityMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([identityMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: identityMigrations.migrationsSchema,
      table: identityMigrations.migrationsTable,
    });
  });

  it('creates its schema idempotently (the migrator creates it first) and carries the trigram index', () => {
    const baseline = readFileSync(join(identityMigrations.folder, '0000_init.sql'), 'utf8');
    expect(baseline).toContain('CREATE SCHEMA IF NOT EXISTS "identity";');
    expect(baseline).not.toMatch(/^CREATE SCHEMA "identity";/m);
    expect(baseline).toContain(
      'CREATE INDEX "users_search_trgm_idx" ON "identity"."users" USING gin',
    );
  });

  it('0001_tenants refuses the platform tenant id (tenants_id_not_platform = PLATFORM_TENANT_ID)', () => {
    const sql = readFileSync(join(identityMigrations.folder, '0001_tenants.sql'), 'utf8');
    expect(sql).toContain(
      `CONSTRAINT "tenants_id_not_platform" CHECK ("id" <> '${PLATFORM_TENANT_ID}'::uuid)`,
    );
    expect(sql).toContain('CONSTRAINT "tenants_slug_unique" UNIQUE("slug")');
  });

  it('0005_tenant_sessions empties sessions first and re-keys them (user_id, id)', () => {
    const sql = readFileSync(join(identityMigrations.folder, '0005_tenant_sessions.sql'), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map((statement) => statement.trim());
    expect(statements[0]).toMatch(/DELETE FROM "identity"\."sessions";$/);
    expect(sql).toContain('DROP CONSTRAINT "sessions_pkey"');
    expect(sql).toContain('ADD CONSTRAINT "sessions_user_id_id_pk" PRIMARY KEY("user_id","id")');
    expect(sql).not.toMatch(/^-- ALTER TABLE/m);
  });

  it('0006 adds users.is_platform_staff; 0007 drops users.roles and the user_role type', () => {
    const add = readFileSync(join(identityMigrations.folder, '0006_platform_staff.sql'), 'utf8');
    expect(add).toContain('ADD COLUMN "is_platform_staff" boolean DEFAULT false NOT NULL');
    expect(add).not.toContain('DROP');
    const drop = readFileSync(join(identityMigrations.folder, '0007_drop_user_roles.sql'), 'utf8');
    expect(drop).toContain('DROP COLUMN "roles"');
    expect(drop).toContain('DROP TYPE "identity"."user_role"');
  });

  it('0008_distribute holds only the app.* distribution calls, references first (sharding design §4.2)', () => {
    const sql = readFileSync(join(identityMigrations.folder, '0008_distribute.sql'), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    expect(statements).toEqual([
      "SELECT app.make_reference('identity.users');",
      "SELECT app.make_reference('identity.tenants');",
      "SELECT app.make_reference('identity.memberships');",
      "SELECT app.distribute_by_tenant('identity.invitations');",
      "SELECT app.distribute_by_tenant('identity.audit_events');",
      "SELECT app.distribute_by_user('identity.sessions');",
    ]);
  });

  describe('0009_rls (spec §8.2 per the row-local ruling of 2026-11-17; B3 Task 10)', () => {
    const statements = (): string[] =>
      readFileSync(join(identityMigrations.folder, '0009_rls.sql'), 'utf8')
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

    /** The text inside the parentheses that open at `open` (balanced). */
    const parenthesised = (text: string, open: number): string => {
      let depth = 0;
      for (let index = open; index < text.length; index += 1) {
        if (text[index] === '(') depth += 1;
        if (text[index] === ')') depth -= 1;
        if (depth === 0) return text.slice(open + 1, index);
      }
      throw new Error(`unbalanced parentheses in: ${text}`);
    };
    const clause = (policy: string, keyword: string): string | null => {
      const at = policy.indexOf(`${keyword} (`);
      return at < 0 ? null : parenthesised(policy, at + keyword.length + 1);
    };

    interface PolicyRow {
      name: string;
      table: string;
      command: string;
      role: string;
      using: string | null;
      check: string | null;
    }
    const policies = (): PolicyRow[] =>
      statements()
        .filter((statement) => /^CREATE POLICY/i.test(statement))
        .map((statement) => {
          const head = /^CREATE POLICY (\w+) ON identity\.(\w+) FOR (\w+) TO (\w+) /.exec(
            statement,
          );
          if (head === null) throw new Error(`unexpected policy shape: ${statement}`);
          const [, name = '', table = '', command = '', role = ''] = head;
          return {
            name,
            table,
            command,
            role,
            using: clause(statement, 'USING'),
            check: clause(statement, 'WITH CHECK'),
          };
        });

    const own = 'id = app.user_id()';
    const notStaff = `${own} AND NOT is_platform_staff`;
    const tenantElevated = 'tenant_id = app.tenant_id() AND app.elevated()';
    const runtime = (
      table: string,
      command: string,
      using: string | null,
      check: string | null,
    ): PolicyRow => ({
      name: `${table}_${command.toLowerCase()}`,
      table,
      command,
      role: 'app_runtime',
      using,
      check,
    });

    it('creates a policy for exactly the cells of the ruled §8.2 table, plus the two app_owner policies', () => {
      expect(policies()).toEqual([
        runtime('users', 'SELECT', own, null),
        runtime('users', 'INSERT', null, notStaff),
        runtime('users', 'UPDATE', own, own),
        {
          name: 'users_owner_select',
          table: 'users',
          command: 'SELECT',
          role: 'app_owner',
          using: 'true',
          check: null,
        },
        {
          name: 'users_owner_update',
          table: 'users',
          command: 'UPDATE',
          role: 'app_owner',
          using: 'true',
          check: null,
        },
        runtime('tenants', 'SELECT', 'id = app.tenant_id()', null),
        runtime('tenants', 'INSERT', null, 'id = app.tenant_id()'),
        runtime(
          'tenants',
          'UPDATE',
          'id = app.tenant_id() AND app.elevated()',
          'id = app.tenant_id() AND app.elevated()',
        ),
        runtime(
          'memberships',
          'SELECT',
          'user_id = app.user_id() OR tenant_id = app.tenant_id()',
          null,
        ),
        runtime('memberships', 'INSERT', null, tenantElevated),
        runtime('memberships', 'UPDATE', tenantElevated, tenantElevated),
        runtime(
          'memberships',
          'DELETE',
          'tenant_id = app.tenant_id() AND (app.elevated() OR user_id = app.user_id())',
          null,
        ),
        runtime('invitations', 'SELECT', tenantElevated, null),
        runtime('invitations', 'INSERT', null, tenantElevated),
        runtime('invitations', 'UPDATE', tenantElevated, tenantElevated),
        runtime('invitations', 'DELETE', tenantElevated, null),
        runtime('sessions', 'SELECT', 'user_id = app.user_id()', null),
        runtime(
          'sessions',
          'INSERT',
          null,
          'user_id = app.user_id() AND tenant_id = app.tenant_id()',
        ),
        runtime('sessions', 'UPDATE', 'user_id = app.user_id()', 'user_id = app.user_id()'),
        runtime('audit_events', 'SELECT', tenantElevated, null),
        runtime('audit_events', 'INSERT', null, 'tenant_id = app.tenant_id()'),
      ]);
    });

    it('has no subquery in any policy (Citus rejects subqueries)', () => {
      const created = statements().filter((statement) => /^CREATE POLICY/i.test(statement));
      expect(created).toHaveLength(21);
      for (const policy of created) {
        expect(policy).not.toMatch(/\(\s*select/i);
        // The only SELECT is the command keyword ("FOR SELECT").
        expect(policy.replace(/ FOR SELECT /, ' ')).not.toMatch(/\bselect\b/i);
      }
    });

    it('enables and forces RLS on all six identity tables, one table per statement', () => {
      const alters = statements().filter((statement) => /^ALTER TABLE/i.test(statement));
      expect(alters).toEqual(
        ['users', 'tenants', 'memberships', 'invitations', 'sessions', 'audit_events'].flatMap(
          (table) => [
            `ALTER TABLE identity.${table} ENABLE ROW LEVEL SECURITY;`,
            `ALTER TABLE identity.${table} FORCE ROW LEVEL SECURITY;`,
          ],
        ),
      );
    });

    it('grants explicitly, one table and one role per GRANT; the users UPDATE list leaves out is_platform_staff', () => {
      const grants = statements().filter((statement) => /^GRANT/i.test(statement));
      expect(grants).toEqual([
        'GRANT USAGE ON SCHEMA identity TO app_runtime;',
        'GRANT USAGE ON SCHEMA identity TO app_system;',
        'GRANT SELECT, INSERT ON TABLE identity.users TO app_runtime;',
        'GRANT UPDATE (email, password_hash, display_name, updated_at) ON TABLE identity.users TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE identity.tenants TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.memberships TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.invitations TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE identity.sessions TO app_runtime;',
        'GRANT SELECT, INSERT ON TABLE identity.audit_events TO app_runtime;',
        'GRANT SELECT ON TABLE identity.users TO app_system;',
        'GRANT SELECT ON TABLE identity.tenants TO app_system;',
        'GRANT SELECT ON TABLE identity.memberships TO app_system;',
        'GRANT SELECT ON TABLE identity.invitations TO app_system;',
        'GRANT SELECT, DELETE ON TABLE identity.sessions TO app_system;',
      ]);
      for (const grant of grants) {
        expect(grant).toMatch(/^GRANT [^;]+ ON (TABLE|SCHEMA) [\w.]+ TO \w+;$/);
      }
      expect(statements().join('\n')).not.toMatch(/__drizzle_migrations|DEFAULT PRIVILEGES/i);
    });

    it('is row-local: no function, and policies call only app.user_id(), app.tenant_id(), app.elevated()', () => {
      const all = statements();
      expect(all.filter((statement) => /\bFUNCTION\b/i.test(statement))).toEqual([]);
      const called = new Set(
        all
          .filter((statement) => /^CREATE POLICY/i.test(statement))
          .flatMap((policy) => [...policy.matchAll(/([\w.]+)\s*\(/g)].map((match) => match[1]))
          // Every word before "(" except the clause and boolean keywords is a function call.
          .filter((name) => name !== undefined && !/^(USING|CHECK|AND|OR|NOT)$/i.test(name)),
      );
      expect([...called].sort()).toEqual(['app.elevated', 'app.tenant_id', 'app.user_id']);
    });
  });

  describe('0010_outbox (outbox plan Task 5: the "Outbox table" SQL, in migration order)', () => {
    const statements = (): string[] =>
      readFileSync(join(identityMigrations.folder, '0010_outbox.sql'), 'utf8')
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

    it('is the plan SQL for identity.outbox, one statement each: CREATE, distribution, indexes, RLS, grants, policy', () => {
      expect(statements()).toEqual([
        'CREATE TABLE "identity"."outbox" ( "tenant_id" uuid NOT NULL, "id" uuid NOT NULL, "topic" text NOT NULL, "key" text, "envelope" jsonb NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL, "published_at" timestamp (3) with time zone, CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id") );',
        "SELECT app.distribute_by_tenant('identity.outbox');",
        'CREATE INDEX "outbox_unpublished_idx" ON "identity"."outbox" USING btree ("created_at","id") WHERE "identity"."outbox"."published_at" IS NULL;',
        'CREATE INDEX "outbox_published_at_idx" ON "identity"."outbox" USING btree ("published_at") WHERE "identity"."outbox"."published_at" IS NOT NULL;',
        'ALTER TABLE "identity"."outbox" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "identity"."outbox" FORCE ROW LEVEL SECURITY;',
        'GRANT INSERT ON "identity"."outbox" TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "identity"."outbox" TO app_system;',
        'CREATE POLICY "outbox_insert" ON "identity"."outbox" FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id());',
      ]);
    });
  });
});
