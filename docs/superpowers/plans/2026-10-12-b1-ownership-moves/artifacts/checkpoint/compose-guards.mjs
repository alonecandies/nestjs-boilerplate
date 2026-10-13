// Parses every app container's resolved docker-compose environment through the config namespaces
// the app loads (platform, domain-owned and app-local), the way each process would at boot (compose
// runs NODE_ENV=production, so the production guards apply). Needs `bun run build` first.
//
//   docker compose --profile microservices --profile monolith config --format json > "$TMPDIR/compose.json"
//   node docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/checkpoint/compose-guards.mjs "$TMPDIR/compose.json"
//
// Exit 1 when a namespace an app loads rejects that app's environment. Rejections in namespaces an
// app does not load are printed as `info` only: that process never validates them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const [composeJson] = process.argv.slice(2);
if (composeJson === undefined) throw new Error('usage: compose-guards.mjs <compose-config.json>');

const load = async (path, exportName) => {
  const module = await import(pathToFileURL(join(ROOT, path)).href);
  const namespace = module[exportName];
  if (typeof namespace?.parse !== 'function') throw new Error(`${path} exports no ${exportName}`);
  return namespace;
};

const platform = await import(pathToFileURL(join(ROOT, 'libs/config/dist/index.js')).href);
const PLATFORM = [
  'app',
  'observability',
  'database',
  'cassandra',
  'redis',
  'kafka',
  'grpc',
  'auth',
  'throttle',
  'cache',
  'graphql',
  'mail',
  'storage',
];
const NAMESPACES = Object.fromEntries(PLATFORM.map((name) => [name, platform[`${name}Config`]]));
// Domain-owned namespaces after B1 (built output of identity-4/5, billing-3/5, billing-7).
const DOMAIN = {
  password: ['domains/identity/dist/infrastructure/security/password.config.js', 'passwordConfig'],
  refreshToken: [
    'domains/identity/dist/infrastructure/security/refresh-token.config.js',
    'refreshTokenConfig',
  ],
  identityGrpcClient: [
    'domains/identity/dist/infrastructure/adapters/grpc/identity-grpc-client.config.js',
    'identityGrpcClientConfig',
  ],
  stripe: ['domains/billing/dist/infrastructure/stripe/stripe.config.js', 'stripeConfig'],
  billingGrpcClient: [
    'domains/billing/dist/infrastructure/adapters/grpc/billing-grpc-client.config.js',
    'billingGrpcClientConfig',
  ],
  notificationsGrpcClient: [
    'domains/notifications/dist/infrastructure/adapters/grpc/notifications-grpc-client.config.js',
    'notificationsGrpcClientConfig',
  ],
  files: ['domains/files/dist/files.config.js', 'filesConfig'],
};
// App-local namespaces (KAFKA_GROUP_ID of the hybrid consumer), read by that app's main.ts.
const APP = {
  monolith: ['apps/monolith/dist/monolith.config.js', 'monolithConfig'],
  gateway: ['apps/gateway/dist/gateway.config.js', 'gatewayConfig'],
};
for (const [name, [path, exportName]] of Object.entries({ ...DOMAIN, ...APP })) {
  NAMESPACES[name] = await load(path, exportName);
}
for (const [name, namespace] of Object.entries(NAMESPACES)) {
  if (typeof namespace?.parse !== 'function') throw new Error(`no parse() for namespace ${name}`);
}

// docs/CONFIGURATION.md, "Which app loads which namespace" (keep the two in sync).
const LOADS = {
  monolith: [
    'app',
    'observability',
    'database',
    'cassandra',
    'redis',
    'kafka',
    'auth',
    'throttle',
    'cache',
    'graphql',
    'mail',
    'storage',
    'stripe',
    'password',
    'refreshToken',
    'files',
    'monolith',
  ],
  gateway: [
    'app',
    'observability',
    'redis',
    'kafka',
    'grpc',
    'auth',
    'throttle',
    'cache',
    'graphql',
    'storage',
    'files',
    'identityGrpcClient',
    'billingGrpcClient',
    'notificationsGrpcClient',
    'gateway',
  ],
  'identity-service': [
    'app',
    'observability',
    'database',
    'redis',
    'kafka',
    'grpc',
    'auth',
    'password',
    'refreshToken',
  ],
  'notifications-service': ['app', 'observability', 'cassandra', 'redis', 'kafka', 'grpc', 'mail'],
  'billing-service': ['app', 'observability', 'database', 'redis', 'kafka', 'grpc', 'stripe'],
};

const print = (line) => process.stdout.write(`${line}\n`);
const compose = JSON.parse(readFileSync(composeJson, 'utf8'));
let failures = 0;
for (const [service, loads] of Object.entries(LOADS)) {
  const definition = compose.services[service];
  if (definition === undefined) throw new Error(`no service ${service}: resolve both profiles`);
  const env = Object.fromEntries(
    Object.entries(definition.environment ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  for (const [name, namespace] of Object.entries(NAMESPACES)) {
    try {
      namespace.parse(env);
    } catch (error) {
      const loaded = loads.includes(name);
      if (loaded) failures += 1;
      const message = String(error?.message ?? error);
      const keys = [...new Set(message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])].join(',');
      print(`${loaded ? 'FAIL' : 'info'} ${service} ${name}: ${keys}`);
      if (loaded) print(`     ${message.split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
}
print(
  failures === 0
    ? 'OK: every app accepts its compose environment'
    : `${failures} loaded namespace(s) rejected`,
);
process.exit(failures === 0 ? 0 : 1);
