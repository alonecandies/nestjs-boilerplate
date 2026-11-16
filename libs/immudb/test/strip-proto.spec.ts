import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/strip-proto.mjs');
const UPSTREAM = join(ROOT, 'vendor/immudb-v1.11.2-schema.proto');
const STRIPPED = join(ROOT, 'proto/immudb/schema/schema.proto');
const UPSTREAM_SHA256 = '66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa';
const IMPORTS =
  'import "google/api/annotations.proto";\nimport "google/protobuf/empty.proto";\n' +
  'import "protoc-gen-swagger/options/annotations.proto";\n';

function strip(input: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'strip-proto-'));
  const source = join(dir, 'in.proto');
  const target = join(dir, 'out.proto');
  writeFileSync(source, input);
  const run = spawnSync(process.execPath, [SCRIPT, source, target], { encoding: 'utf8' });
  return { status: run.status, output: run.status === 0 ? readFileSync(target, 'utf8') : '' };
}

describe('strip-proto', () => {
  it('vendors the exact upstream v1.11.2 schema.proto', () => {
    const digest = createHash('sha256').update(readFileSync(UPSTREAM)).digest('hex');
    expect(digest).toBe(UPSTREAM_SHA256);
  });

  it('the committed stripped proto equals strip(upstream) (regenerate with proto:gen)', () => {
    const { status, output } = strip(readFileSync(UPSTREAM, 'utf8'));
    expect(status).toBe(0);
    expect(output).toBe(readFileSync(STRIPPED, 'utf8'));
  });

  it('keeps every rpc and the well-known imports, drops annotations', () => {
    const upstream = readFileSync(UPSTREAM, 'utf8');
    const stripped = readFileSync(STRIPPED, 'utf8');
    const rpcs = (text: string): number => text.match(/^\s*rpc \w+\(/gm)?.length ?? 0;
    expect(rpcs(stripped)).toBe(rpcs(upstream));
    expect(rpcs(stripped)).toBeGreaterThan(70);
    expect(stripped).not.toMatch(/option \(/);
    expect(stripped).not.toContain('google/api/annotations.proto');
    expect(stripped).toContain('import "google/protobuf/empty.proto";');
  });

  it('removes scalar and aggregate options, braces inside strings included', () => {
    const { status, output } = strip(
      `${IMPORTS}option (a.b) = { x: "}{"; y: { z: 1 } };\nservice S {\n  rpc A(E) returns (E) {\n` +
        '    option (google.api.http) = {\n      get: "/a/{id}"\n    };\n  }\n  option (c) = 3;\n}\n',
    );
    expect(status).toBe(0);
    expect(output).toBe(
      'import "google/protobuf/empty.proto";\nservice S {\n  rpc A(E) returns (E) {\n  }\n}\n',
    );
  });

  it('fails when upstream no longer has the imports it expects', () => {
    expect(strip('syntax = "proto3";\n').status).not.toBe(0);
  });
});
