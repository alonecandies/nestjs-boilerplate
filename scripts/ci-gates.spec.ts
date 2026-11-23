import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * CI-1 (audit 2026-11-23): CI gates advisories, image OS packages and coverage; actions and the
 * distroless base are pinned; commitlint and the proto breaking check run on direct pushes too.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency: { group: string };
  jobs: Record<string, Job>;
}

const CI_TEXT = read('.github/workflows/ci.yml');
const CI = parse(CI_TEXT) as Workflow;
const DOCKERFILE = read('Dockerfile');
const job = (name: string): Job => {
  const found = CI.jobs[name];
  if (found === undefined) throw new Error(`ci.yml has no job ${name}`);
  return found;
};
const stepRunning = (jobName: string, command: string): Step => {
  const found = job(jobName).steps.find((step) => step.run?.includes(command));
  if (found === undefined) throw new Error(`job ${jobName} has no step running ${command}`);
  return found;
};
/** Everything a step evaluates: its condition, env and script. */
const stepText = (step: Step): string =>
  [step.if ?? '', ...Object.values(step.env ?? {}), step.run ?? ''].join('\n');

const TRIVY_V0_36_0 = 'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25';

describe('.github/workflows/ci.yml and the Dockerfile (CI-1)', () => {
  it('pins every action to a 40-character commit SHA with its tag in a comment', () => {
    const lines = CI_TEXT.split('\n').filter((text) => /^\s*(?:-\s+)?uses:/.test(text));
    expect(lines.length).toBeGreaterThanOrEqual(9);
    for (const text of lines) {
      expect(text).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/);
    }
    const parsed = Object.values(CI.jobs).flatMap((each) =>
      each.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    );
    expect(parsed).toHaveLength(lines.length);
    for (const uses of parsed) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('pins the distroless runtime base by its multi-arch index digest', () => {
    expect(DOCKERFILE).toMatch(
      /^ARG DISTROLESS_IMAGE=gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256:[0-9a-f]{64}$/m,
    );
    expect(DOCKERFILE).toMatch(/^FROM \$\{DISTROLESS_IMAGE\} AS runtime$/m);
  });

  it('runs commitlint and the proto breaking check on pushes too, against github.event.before', () => {
    expect(CI.on).toHaveProperty('push');
    for (const command of ['commitlint', 'scripts/check-proto-breaking.mjs']) {
      const step = stepRunning('verify', command);
      expect(step.if ?? '', command).not.toContain('pull_request');
      expect(stepText(step), command).toContain('github.event.before');
      expect(stepText(step), command).toContain('github.event.pull_request.base.sha');
    }
  });

  it('gates the verify job on high and critical production advisories', () => {
    stepRunning('verify', 'node scripts/check-audit.mjs');
  });

  it('reports advisories from a weekly scheduled run that starts nothing else', () => {
    const schedule = CI.on.schedule as { cron: string }[] | undefined;
    expect(schedule?.[0]?.cron).toMatch(/^\S+ \S+ \* \* [0-6]$/);
    const advisories = job('advisories');
    expect(advisories.if).toBe("github.event_name == 'schedule'");
    // Its own concurrency group: a group keeps one pending run, so a scheduled run queued in the
    // master group would cancel a pending push run.
    expect(CI.concurrency.group).toContain("github.event_name == 'schedule'");
    expect(
      advisories.steps.some((step) => step.run?.includes('node scripts/check-audit.mjs')),
    ).toBe(true);
    for (const [name, each] of Object.entries(CI.jobs)) {
      if (name === 'advisories') continue;
      // A job that needs another one is skipped with it.
      if (each.needs !== undefined) continue;
      expect(each.if, name).toBe("github.event_name != 'schedule'");
    }
  });

  it('runs the unit and e2e tests with coverage in the verify job, once', () => {
    stepRunning('verify', 'bun run test:cov');
    const plain = job('verify').steps.filter((step) => /bun run test\s*$/m.test(step.run ?? ''));
    expect(plain).toEqual([]);
  });

  it('scans each built image for fixable high and critical OS vulnerabilities with Trivy', () => {
    const steps = job('image').steps;
    const build = steps.findIndex((step) => step.uses?.startsWith('docker/build-push-action@'));
    const scan = steps.findIndex((step) => step.uses === TRIVY_V0_36_0);
    const save = steps.findIndex((step) => step.run?.includes('docker save'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(build);
    expect(save).toBeGreaterThan(scan);
    // String() so a YAML boolean or number and its quoted form compare the same.
    const inputs = Object.fromEntries(
      Object.entries(steps[scan]?.with ?? {}).map(([key, value]) => [key, String(value)]),
    );
    expect(inputs).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the test data.
      'image-ref': 'boilerplate/${{ matrix.app }}:ci',
      'vuln-type': 'os',
      severity: 'HIGH,CRITICAL',
      'ignore-unfixed': 'true',
      'exit-code': '1',
    });
  });

  it('prints the runtime Node version of each image', () => {
    expect(stepRunning('image', 'docker image inspect').run).toMatch(
      /docker run --rm boilerplate\/\$\{\{ matrix\.app \}\}:ci --version/,
    );
  });

  it('has a check:audit script', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['check:audit']).toBe('node scripts/check-audit.mjs');
  });
});

describe('.github/dependabot.yml (CI-1)', () => {
  interface Update {
    'package-ecosystem': string;
    directory: string;
    'commit-message'?: { prefix?: string; include?: string };
  }
  const config = parse(read('.github/dependabot.yml')) as { version: number; updates: Update[] };

  it('updates the GitHub Actions and the Docker base images, and npm only through the gate', () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((update) => update['package-ecosystem']).sort()).toEqual([
      'docker',
      'github-actions',
    ]);
    for (const update of config.updates) expect(update.directory).toBe('/');
  });

  it('writes commit headers commitlint accepts (<type>(deps): ...)', () => {
    for (const update of config.updates) {
      expect(['build', 'ci', 'chore', 'fix']).toContain(update['commit-message']?.prefix);
      expect(update['commit-message']?.include).toBe('scope');
    }
  });
});

describe('the docs describe the gates (CI-1)', () => {
  const releasing = read('docs/RELEASING.md');
  const testing = read('docs/TESTING.md');
  const docker = read('docs/DOCKER.md');

  it('docs/RELEASING.md names the advisory, image and coverage gates and the digest bump', () => {
    for (const text of [
      'scripts/check-audit.mjs',
      '.github/audit-ignore.json',
      'aquasecurity/trivy-action',
      'bun run test:cov',
      'github.event.before',
      '.github/dependabot.yml',
      'DISTROLESS_IMAGE',
      '/v2/distroless/nodejs24-debian13/manifests/nonroot',
    ]) {
      expect(releasing, text).toContain(text);
    }
    expect(releasing).not.toContain('(PRs only)');
  });

  it('docs/TESTING.md gives the coverage thresholds', () => {
    expect(testing).toMatch(/thresholds/);
    expect(testing).toContain('COVERAGE_THRESHOLDS');
  });

  it('docs/DOCKER.md says the distroless base is pinned by digest', () => {
    expect(docker).toMatch(/gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256/);
    expect(docker).not.toMatch(/pull requests only/);
  });
});
