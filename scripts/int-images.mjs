// Prints the container images the integration (`*.int-spec.ts`) specs start, one per line, read from
// the image constants next to the code that starts them (no build needed):
//   node scripts/int-images.mjs [--root <dir>] [--names]
// The CI `integration` job pre-pulls this list (`... | xargs -P 4 -n 1 docker pull`), so no spec
// spends its hook timeout on a download. --names prints `CONSTANT=image` instead (the spec
// scripts/int-images.spec.ts checks every container a spec or helper starts is named here).
// --root reads another tree (fixtures). Exits 1 when a constant cannot be found.
// The list also holds RYUK_IMAGE, the reaper testcontainers starts first in every fork, read from
// the installed testcontainers (its default; RYUK_CONTAINER_IMAGE is not set in CI), so the
// integration job runs this after `bun install`.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { root: { type: 'string' }, names: { type: 'boolean', default: false } },
});
const root = args.root ?? join(import.meta.dirname, '..');

/** The file that declares each image constant, and the constants (in file order). */
const SOURCES = [
  ['libs/testing/src/postgres/start-test-postgres.ts', ['TEST_POSTGRES_IMAGE']],
  ['libs/testing/src/cassandra/start-test-cassandra.ts', ['TEST_CASSANDRA_IMAGE']],
  ['libs/outbox/test/outbox-kafka-delivery.int-spec.ts', ['KAFKA_IMAGE']],
  ['libs/transport/test/support/kafka-container.ts', ['TRANSPORT_KAFKA_IMAGE']],
  ['libs/outbox/test/outbox-relay.int-spec.ts', ['REDIS_IMAGE']],
  ['libs/immudb/src/index.ts', ['IMMUDB_TEST_IMAGE']],
  ['libs/storage/test/emulators.ts', ['RUSTFS_IMAGE', 'FAKE_GCS_IMAGE']],
];

/** `const NAME = 'text'` or a template literal, with `${OTHER}` of the same file substituted. */
function constants(text) {
  const found = new Map();
  for (const match of text.matchAll(/^(?:export )?const (\w+) = (['`])(.*?)\2;$/gm)) {
    const value = match[3].replace(/\$\{(\w+)\}/g, (whole, name) => found.get(name) ?? whole);
    found.set(match[1], value);
  }
  return found;
}

const rows = [];
const problems = [];
for (const [file, names] of SOURCES) {
  let found;
  try {
    found = constants(readFileSync(join(root, file), 'utf8'));
  } catch {
    problems.push(`${file}: cannot be read (${names.join(', ')})`);
    continue;
  }
  for (const name of names) {
    const image = found.get(name);
    if (image === undefined || image.includes('${')) {
      problems.push(`${file}: no plain string constant ${name}`);
    } else {
      rows.push([name, image]);
    }
  }
}

// testcontainers resolved as libs/testing (which starts the containers) resolves it.
try {
  const require = createRequire(join(root, 'libs', 'testing', 'package.json'));
  const reaper = join(
    dirname(require.resolve('testcontainers/package.json')),
    'build',
    'reaper',
    'reaper.js',
  );
  const ryuk = /ImageName\.fromString\("([^"]+)"\)/.exec(readFileSync(reaper, 'utf8'))?.[1];
  if (ryuk === undefined) problems.push(`${reaper}: no default Ryuk image (RYUK_IMAGE)`);
  else rows.unshift(['RYUK_IMAGE', ryuk]);
} catch (error) {
  problems.push(
    `testcontainers: cannot read its Ryuk image (RYUK_IMAGE): ${error instanceof Error ? error.message : error}`,
  );
}

if (problems.length > 0) {
  console.error(`int-images: ${problems.join('\n')}`);
  process.exit(1);
}
const seen = new Set();
for (const [name, image] of rows) {
  if (args.names) console.log(`${name}=${image}`);
  else if (!seen.has(image)) console.log(image);
  seen.add(image);
}
