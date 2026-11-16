// `buf breaking` for every gRPC contracts package (domains/<x>/contracts with a src/proto root)
// against a git ref, normally the pull request's base. A deleted field, renamed RPC or changed
// type fails; additions pass (policy: libs/contracts/buf.yaml, `breaking.use: [FILE]`, applied to
// both sides). A package whose src/proto does not exist at the ref is new and is skipped. The
// base protos are extracted with `git archive` (no buf git input: that needs branch names and
// enough clone depth).
//   node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>] [--buf <path>]
//                                         [--error-format text|github-actions|json]
// Exit: 0 no breaking change, 1 breaking change or error, 2 usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    against: { type: 'string' },
    root: { type: 'string' },
    buf: { type: 'string' },
    'error-format': { type: 'string', default: 'text' },
  },
});
if (args.against === undefined) {
  console.error('usage: node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>]');
  process.exit(2);
}
const against = args.against;
const root = args.root ?? join(import.meta.dirname, '..');
const buf = args.buf ?? join(import.meta.dirname, '..', 'node_modules', '.bin', 'buf');
const config = join(root, 'libs', 'contracts', 'buf.yaml');

const git = (gitArgs, options = {}) =>
  spawnSync('git', gitArgs, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });

if (git(['rev-parse', '--verify', '--quiet', `${against}^{commit}`]).status !== 0) {
  console.error(`unknown git ref ${against} (fetch it first, e.g. git fetch origin master)`);
  process.exit(1);
}

const domainsDir = join(root, 'domains');
const packages = existsSync(domainsDir)
  ? readdirSync(domainsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `domains/${entry.name}/contracts`)
      .filter((pkg) => existsSync(join(root, pkg, 'src', 'proto')))
      .sort()
  : [];
if (packages.length === 0) {
  console.error(`no contracts package with a src/proto folder under ${domainsDir}`);
  process.exit(1);
}

const baseDir = mkdtempSync(join(tmpdir(), 'proto-breaking-'));
let failed = 0;
try {
  for (const pkg of packages) {
    const protoRoot = `${pkg}/src/proto`;
    if (git(['cat-file', '-e', `${against}:${protoRoot}`]).status !== 0) {
      console.info(`skip ${pkg}: no src/proto at ${against} (new package)`);
      continue;
    }
    const archive = git(['archive', '--format=tar', against, protoRoot]);
    if (archive.status !== 0)
      throw new Error(`git archive ${against} ${protoRoot}: ${archive.stderr}`);
    const untar = spawnSync('tar', ['-x', '-C', baseDir], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar -x: ${untar.stderr}`);

    const result = spawnSync(
      buf,
      [
        'breaking',
        '--config',
        config,
        '--against',
        join(baseDir, pkg),
        '--against-config',
        config,
        '--error-format',
        args['error-format'],
      ],
      { cwd: join(root, pkg), encoding: 'utf8' },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error !== undefined) throw result.error;
    if (result.status === 0) {
      console.info(`ok   ${pkg}: no breaking change against ${against}`);
    } else {
      failed += 1;
      console.error(`FAIL ${pkg}: breaking change against ${against} (buf exit ${result.status})`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed += 1;
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(
    'A breaking proto change needs a new package version (<ctx>.v2) served next to v1: docs/RELEASING.md',
  );
  process.exit(1);
}
