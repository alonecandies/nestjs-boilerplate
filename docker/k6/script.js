// biome-ignore-all lint/correctness/noUndeclaredDependencies: k6/* are k6 built-in modules, not npm packages.
// k6 v2 load test of the edge API (the monolith and the gateway both answer on http://api:3000).
//
// Scenario `journey` (always on) — the onboarding flow of a NEW user, RATE times per second:
//   POST /v1/auth/register (unique email) → POST /v1/auth/login → GET /v1/auth/me
//   → GET /v1/users/:id (served from the L1/L2 user cache warmed by /me) → POST /graphql { me }
// Scenario `browse` (READ_RATE > 0) — authenticated reads only (/me, /users/:id, GraphQL me) by a
//   pool of users registered in setup(); models the read-heavy steady state.
//
// Open model (constant-arrival-rate): the request rate stays fixed whatever the latency, so the
// percentiles are honest (a closed VU loop slows down with the server = coordinated omission).
// Each iteration sends a distinct X-Forwarded-For (TRUST_PROXY=true), so the per-client auth
// throttle (THROTTLE_AUTH_LIMIT per minute per IP) models many clients instead of one k6 box.
//
// Env: BASE_URL, RATE (journeys/s, default 5), DURATION (default 1m), READ_RATE (iterations/s,
// default 0), P95_MS (default 250), MAX_ERROR_RATE (default 0.01), MAX_DROPPED_RATIO (default
// 0.01 of the planned iterations), THROTTLE_LIMIT (app setting, default 100/min/user; sizes the
// browse pool), PASSWORD, RUN_ID.
// Keep DURATION below JWT_ACCESS_TTL_SEC (15 min) when READ_RATE > 0: pool tokens are not refreshed.
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const BASE_URL = (__ENV.BASE_URL || 'http://api:3000').replace(/\/+$/, '');
const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || '1m';
const READ_RATE = Number(__ENV.READ_RATE || 0);
const P95_MS = Number(__ENV.P95_MS || 250);
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);
const MAX_DROPPED_RATIO = Number(__ENV.MAX_DROPPED_RATIO || 0.01);
const THROTTLE_LIMIT = Number(__ENV.THROTTLE_LIMIT || 100);
const PASSWORD = __ENV.PASSWORD || 'k6-load-test-Passw0rd';
// Emails must be unique across runs against the same database.
const RUN_ID = (__ENV.RUN_ID || Date.now().toString(36)).toLowerCase();
const READS_PER_ITERATION = 3;

/** k6 duration string ("90s", "1m30s", "2h") -> seconds. */
function durationSeconds(value) {
  const units = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, amount, unit] of String(value).matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) {
    total += Number(amount) * units[unit];
  }
  return total || Number(value) || 0;
}
const PLANNED_ITERATIONS = (RATE + READ_RATE) * durationSeconds(DURATION);

const ME_QUERY = 'query Me { me { id email displayName roles } }';
const JSON_HEADERS = { 'content-type': 'application/json' };

const scenarios = {
  journey: {
    executor: 'constant-arrival-rate',
    exec: 'journey',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    // ~5 sequential requests (2 of them Argon2id-bound) per iteration.
    preAllocatedVUs: Math.max(5, Math.ceil(RATE * 2)),
    maxVUs: Math.max(50, Math.ceil(RATE * 20)),
    tags: { phase: 'load' },
  },
};
if (READ_RATE > 0) {
  scenarios.browse = {
    executor: 'constant-arrival-rate',
    exec: 'browse',
    rate: READ_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(5, Math.ceil(READ_RATE / 5)),
    maxVUs: Math.max(50, Math.ceil(READ_RATE * 2)),
    tags: { phase: 'load' },
  };
}

export const options = {
  scenarios,
  // setup() traffic (health polling, warm-up) is untagged, so it never counts against thresholds.
  thresholds: {
    'http_req_failed{phase:load}': [`rate<${MAX_ERROR_RATE}`],
    'http_req_duration{phase:load}': [`p(95)<${P95_MS}`],
    'checks{phase:load}': [`rate>${1 - MAX_ERROR_RATE}`],
    // Cached reads must stay well under the overall budget (no Argon2 on these paths).
    // (Tag values in threshold selectors must not contain ':' or ',' — hence "<id>".)
    'http_req_duration{phase:load,name:GET /v1/users/<id>}': [`p(95)<${Math.ceil(P95_MS / 2)}`],
    // Drops = the API (or the VU pool) could not sustain the arrival rate. A small budget absorbs
    // one GC/VM hiccup on a laptop; sustained saturation still fails the run.
    dropped_iterations: [`count<=${Math.floor(PLANNED_ITERATIONS * MAX_DROPPED_RATIO)}`],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '180s',
};

/** 10.x.y.z from a sequence number: a distinct client address per iteration / pool user. */
function clientIp(n, block = 0) {
  return `10.${(block * 64 + ((n >> 16) & 63)) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

function register(email, displayName, ip, tags) {
  return http.post(
    `${BASE_URL}/v1/auth/register`,
    JSON.stringify({ email, password: PASSWORD, displayName }),
    {
      headers: { ...JSON_HEADERS, 'x-forwarded-for': ip },
      tags: { name: 'POST /v1/auth/register', ...tags },
    },
  );
}

function login(email, ip) {
  return http.post(`${BASE_URL}/v1/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { ...JSON_HEADERS, 'x-forwarded-for': ip },
    tags: { name: 'POST /v1/auth/login' },
  });
}

/** The three authenticated reads shared by both scenarios. */
function readAs(token, userId, ip) {
  const headers = { authorization: `Bearer ${token}`, 'x-forwarded-for': ip };

  const me = http.get(`${BASE_URL}/v1/auth/me`, { headers, tags: { name: 'GET /v1/auth/me' } });
  check(me, { 'GET /v1/auth/me 200 (self)': (r) => r.status === 200 && r.json('id') === userId });

  const user = http.get(`${BASE_URL}/v1/users/${userId}`, {
    headers,
    tags: { name: 'GET /v1/users/<id>' },
  });
  check(user, { 'GET /v1/users/<id> 200': (r) => r.status === 200 && r.json('id') === userId });

  const gql = http.post(`${BASE_URL}/graphql`, JSON.stringify({ query: ME_QUERY }), {
    headers: { ...headers, ...JSON_HEADERS },
    tags: { name: 'POST /graphql me' },
  });
  check(gql, {
    'GraphQL me (no errors)': (r) =>
      r.status === 200 && !r.json('errors') && r.json('data.me.id') === userId,
  });
}

export function setup() {
  // 1. Wait (max ~2 min) for readiness so the test never measures a cold start.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = http.get(`${BASE_URL}/health/ready`, { responseType: 'none' }).status === 200;
    if (!ready) sleep(1);
  }
  if (!ready) fail(`API at ${BASE_URL} is not ready (GET /health/ready != 200)`);

  // 2. Browse pool: enough users that each stays under the per-user THROTTLE_LIMIT per minute.
  const poolSize =
    READ_RATE > 0
      ? Math.min(
          500,
          Math.max(2, Math.ceil((READ_RATE * READS_PER_ITERATION * 60) / (THROTTLE_LIMIT * 0.8))),
        )
      : 1;
  const pool = [];
  // The first registration also warms the whole path (gateway -> gRPC -> Postgres); retry it.
  // A fresh email per attempt: a timed-out attempt may still have created its user.
  for (let attempt = 0; attempt < 30 && pool.length === 0; attempt++) {
    const email = `k6.${RUN_ID}.warmup${attempt}@loadtest.example.com`;
    const res = register(email, 'k6 warm-up', clientIp(attempt, 2), {});
    if (res.status === 201) pool.push({ token: res.json('accessToken'), id: res.json('user.id') });
    else if (res.status === 409) fail(`RUN_ID ${RUN_ID} was already used against this database`);
    else sleep(2);
  }
  if (pool.length === 0) fail('warm-up registration never succeeded');

  for (let start = 1; start < poolSize; start += 10) {
    const batch = [];
    for (let n = start; n < Math.min(poolSize, start + 10); n++) {
      batch.push({
        method: 'POST',
        url: `${BASE_URL}/v1/auth/register`,
        body: JSON.stringify({
          email: `k6.${RUN_ID}.pool${n}@loadtest.example.com`,
          password: PASSWORD,
          displayName: `k6 pool ${n}`,
        }),
        params: { headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp(n, 3) } },
      });
    }
    for (const res of http.batch(batch)) {
      if (res.status !== 201) fail(`pool registration failed: HTTP ${res.status} ${res.body}`);
      pool.push({ token: res.json('accessToken'), id: res.json('user.id') });
    }
  }
  return { pool };
}

export function journey() {
  const n = exec.scenario.iterationInTest;
  const ip = clientIp(n);
  const email = `k6.${RUN_ID}.${n}@loadtest.example.com`;

  const reg = register(email, `k6 user ${n}`, ip, {});
  if (!check(reg, { 'POST /v1/auth/register 201': (r) => r.status === 201 })) return;

  const res = login(email, ip);
  if (!check(res, { 'POST /v1/auth/login 200': (r) => r.status === 200 })) return;

  readAs(res.json('accessToken'), res.json('user.id'), ip);
}

export function browse(data) {
  const n = exec.scenario.iterationInTest;
  const user = data.pool[n % data.pool.length];
  readAs(user.token, user.id, clientIp(n, 1));
}
