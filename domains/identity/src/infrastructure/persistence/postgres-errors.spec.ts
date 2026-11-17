import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './postgres-errors.js';

/** postgres.js PostgresError shape: an Error carrying `code` and, when known, `constraint_name`. */
const pgError = (fields: { code: string; constraint_name?: string; message: string }): Error =>
  Object.assign(new Error(fields.message), fields);

const uniqueMessage = (constraint: string): string =>
  `duplicate key value violates unique constraint "${constraint}"`;

/** drizzle 0.45 wraps the driver error in DrizzleQueryError, with the driver error as `cause`. */
const wrapped = (cause: unknown): Error =>
  new Error('Failed query: insert into "identity"."users" ...', { cause });

describe('isUniqueViolation', () => {
  describe('plain Postgres (constraint_name is the logical name)', () => {
    const error = pgError({
      code: '23505',
      constraint_name: 'users_email_unique',
      message: uniqueMessage('users_email_unique'),
    });

    it('matches any unique violation without a constraint', () => {
      expect(isUniqueViolation(error)).toBe(true);
    });

    it('matches the exact constraint', () => {
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(true);
    });

    it('does not match another constraint', () => {
      expect(isUniqueViolation(error, 'tenants_slug_unique')).toBe(false);
    });
  });

  describe('Citus, local execution on (constraint_name carries the shard suffix)', () => {
    const error = pgError({
      code: '23505',
      constraint_name: 'users_email_unique_102008',
      message: uniqueMessage('users_email_unique_102008'),
    });

    it('matches the logical name', () => {
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(true);
    });

    it('does not match a constraint that only shares a prefix', () => {
      expect(isUniqueViolation(error, 'users_email')).toBe(false);
      expect(isUniqueViolation(error, 'users_email_unique_10200')).toBe(false);
    });
  });

  describe('Citus, local execution off (no constraint_name; the message names the shard constraint)', () => {
    const error = pgError({
      code: '23505',
      message: uniqueMessage('tenants_slug_unique_102040'),
    });

    it('matches the logical name from the message', () => {
      expect(isUniqueViolation(error, 'tenants_slug_unique')).toBe(true);
    });

    it('matches the unsuffixed name in the message', () => {
      const plain = pgError({ code: '23505', message: uniqueMessage('tenants_slug_unique') });
      expect(isUniqueViolation(plain, 'tenants_slug_unique')).toBe(true);
    });

    it('does not match another constraint', () => {
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });

    it('does not match when the message names no constraint', () => {
      const bare = pgError({ code: '23505', message: 'duplicate key value' });
      expect(isUniqueViolation(bare)).toBe(true);
      expect(isUniqueViolation(bare, 'tenants_slug_unique')).toBe(false);
    });
  });

  describe('a different constraint that merely shares a prefix', () => {
    it.each([
      ['constraint_name', 'users_email_unique_extra'],
      ['constraint_name', 'users_email_unique_extra_102008'],
      ['constraint_name', 'users_email_unique_102008x'],
      ['constraint_name', 'users_email_unique_'],
      ['constraint_name', 'users_email_uniquex'],
      ['message', 'users_email_unique_extra'],
      ['message', 'users_email_unique_extra_102008'],
      ['message', 'users_email_unique_abc'],
      ['message', 'users_email_unique_'],
    ])('does not match when %s names %s', (where, name) => {
      const error =
        where === 'constraint_name'
          ? pgError({ code: '23505', constraint_name: name, message: uniqueMessage(name) })
          : pgError({ code: '23505', message: uniqueMessage(name) });
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });

    it('treats regex metacharacters in the logical name literally', () => {
      const error = pgError({
        code: '23505',
        constraint_name: 'usersXemail_unique_1',
        message: '',
      });
      expect(isUniqueViolation(error, 'users.email_unique')).toBe(false);
    });
  });

  describe('constraint_name wins over the message', () => {
    it('does not fall back to the message when constraint_name names another constraint', () => {
      const error = pgError({
        code: '23505',
        constraint_name: 'tenants_slug_unique_102040',
        message: uniqueMessage('users_email_unique_102008'),
      });
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });
  });

  describe('the cause chain', () => {
    it('finds a shard-suffixed violation under a drizzle wrapper', () => {
      const error = wrapped(
        pgError({
          code: '23505',
          constraint_name: 'memberships_tenant_id_user_id_pk_102016',
          message: uniqueMessage('memberships_tenant_id_user_id_pk_102016'),
        }),
      );
      expect(isUniqueViolation(error, 'memberships_tenant_id_user_id_pk')).toBe(true);
    });

    it('finds a relayed violation (message only) under a drizzle wrapper', () => {
      const error = wrapped(
        pgError({ code: '23505', message: uniqueMessage('users_email_unique_102008') }),
      );
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(true);
    });

    it('ignores the wrapper message: only the 23505 error is read', () => {
      const error = new Error(uniqueMessage('users_email_unique'), {
        cause: pgError({ code: '23505', message: uniqueMessage('tenants_slug_unique_102040') }),
      });
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });

    it('stops after five levels', () => {
      let error: unknown = pgError({
        code: '23505',
        constraint_name: 'users_email_unique',
        message: uniqueMessage('users_email_unique'),
      });
      for (let depth = 0; depth < 5; depth += 1) error = wrapped(error);
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });
  });

  describe('other errors', () => {
    it('does not match another SQLSTATE that names the constraint', () => {
      const error = pgError({
        code: '23514',
        message:
          'new row for relation "users_102008" violates check constraint "users_email_unique_102008"',
      });
      expect(isUniqueViolation(error)).toBe(false);
      expect(isUniqueViolation(error, 'users_email_unique')).toBe(false);
    });

    it.each([undefined, null, 'users_email_unique', 23505, new Error('boom')])(
      'returns false for %s',
      (value) => {
        expect(isUniqueViolation(value, 'users_email_unique')).toBe(false);
      },
    );
  });
});
