import { describe, expect, it } from 'vitest';
import { splitCqlStatements } from './cql-script.js';

describe('splitCqlStatements', () => {
  it('splits on ; and trims, keeping multi-line statements intact', () => {
    const script = `
      CREATE TABLE IF NOT EXISTS a (
        id uuid PRIMARY KEY,
        n int
      );
      CREATE INDEX IF NOT EXISTS a_n ON a (n);
    `;
    expect(splitCqlStatements(script)).toEqual([
      'CREATE TABLE IF NOT EXISTS a (\n        id uuid PRIMARY KEY,\n        n int\n      )',
      'CREATE INDEX IF NOT EXISTS a_n ON a (n)',
    ]);
  });

  it('keeps a final statement without a trailing semicolon and drops empty ones', () => {
    expect(splitCqlStatements('SELECT 1;;  ;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitCqlStatements('')).toEqual([]);
    expect(splitCqlStatements('  \n ; \n')).toEqual([]);
  });

  it('strips --, // and /* */ comments (including ones containing ;)', () => {
    const script = [
      '-- header; not a statement',
      '// another; comment',
      'CREATE TABLE t (id int PRIMARY KEY); -- trailing; comment',
      '/* block; comment',
      '   spanning lines */ ALTER TABLE t ADD n int;',
    ].join('\n');
    expect(splitCqlStatements(script)).toEqual([
      'CREATE TABLE t (id int PRIMARY KEY)',
      'ALTER TABLE t ADD n int',
    ]);
  });

  it('does not split inside string literals, doubled-quote escapes or quoted identifiers', () => {
    const script = `INSERT INTO t (k, v) VALUES ('a;b', 'it''s; fine');
      SELECT "weird;name" FROM t;`;
    expect(splitCqlStatements(script)).toEqual([
      "INSERT INTO t (k, v) VALUES ('a;b', 'it''s; fine')",
      'SELECT "weird;name" FROM t',
    ]);
  });

  it('keeps comment markers that appear inside strings', () => {
    expect(splitCqlStatements("INSERT INTO t (v) VALUES ('-- not a comment /* nope */');")).toEqual(
      ["INSERT INTO t (v) VALUES ('-- not a comment /* nope */')"],
    );
  });

  it('does not split inside $$ bodies (UDFs)', () => {
    const script = `CREATE FUNCTION IF NOT EXISTS f (x int) RETURNS NULL ON NULL INPUT RETURNS int
      LANGUAGE java AS $$ int y = x; return y; $$;
      SELECT 1;`;
    const statements = splitCqlStatements(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/AS \$\$ int y = x; return y; \$\$$/);
  });

  it.each([
    ["SELECT 'open", /Unterminated string literal starting on line 1/],
    ['SELECT 1;\nSELECT "open', /Unterminated quoted identifier starting on line 2/],
    ['SELECT 1; /* never closed', /Unterminated block comment/],
    ['CREATE FUNCTION f AS $$ body', /Unterminated \$\$ block/],
  ])('reports unterminated constructs with a line number: %j', (script, error) => {
    expect(() => splitCqlStatements(script)).toThrow(error);
  });
});
