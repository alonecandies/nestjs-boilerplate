import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AI plan Task 7: the docs describe the AI feature as built. Every list a doc repeats (config keys,
 * error codes, routes, GraphQL fields, RPCs, tools, metrics) is read from the code that owns it, so a
 * key, a route or a tool added later fails here until the doc names it.
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/** The text of one `##`/`###` section: from its heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no section "${heading}"`);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const length = lines
    .slice(start + 1)
    .findIndex((line) => new RegExp(`^#{1,${level}} `).test(line) && !line.startsWith('```'));
  return lines.slice(start, length === -1 ? undefined : start + 1 + length).join('\n');
}

/** First-column `code` cell of every table row. */
const firstCells = (markdown: string): string[] =>
  markdown.split('\n').flatMap((line) => /^\| `([^`]+)`\s*\|/.exec(line)?.[1] ?? []);

/** Collapses line wraps, so a phrase matches wherever prettier broke the line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The string values of `export const <object> = { ... } as const` in `file`. */
const constValues = (file: string, object: string): string[] => {
  const block =
    new RegExp(`export const ${object} = \\{([\\s\\S]*?)\\} as const`).exec(read(file))?.[1] ?? '';
  return [...block.matchAll(/:\s*'([A-Za-z_:.-]+)'/g)].map((match) => match[1] ?? '');
};

/** UPPER_CASE keys of the `z.object({ ... })` in a config file, minus the shared ones. */
const configKeys = (file: string): string[] =>
  [...read(file).matchAll(/^\s{4}([A-Z][A-Z0-9_]*):/gm)]
    .map((match) => match[1] ?? '')
    .filter((key) => !['NODE_ENV', 'ALLOW_KNOWN_LOCAL_SECRETS'].includes(key));

const AI_CONFIG = 'libs/config/src/namespaces/ai.config.ts';
const AI_RATE_LIMIT_CONFIG = 'domains/ai/src/presentation/rate-limit/ai-rate-limit.config.ts';
const AI_GRPC_CLIENT_CONFIG =
  'domains/ai/src/infrastructure/adapters/grpc/ai-grpc-client.config.ts';
const LIB_ERRORS = 'libs/ai/src/ai.errors.ts';
const CHAT_ERRORS = 'domains/ai/src/ai.constants.ts';
const TOOLS = 'domains/ai/src/application/tools/ai-tools.ts';
const METRICS = ['ai_requests_total', 'ai_tokens_total', 'ai_request_duration_seconds'];

/** `METHOD /v1/ai/conversations[/path]` of every handler of the REST controller. */
const restRoutes = (): string[] => {
  const source = read('domains/ai/src/presentation/http/ai.controller.ts');
  const prefix = /@Controller\(\{ path: '([^']+)'/.exec(source)?.[1] ?? '';
  return [...source.matchAll(/@(Get|Post|Delete|Patch|Put)\((?:'([^']*)')?\)/g)].map(
    ([, method = '', path = '']) =>
      `${method.toUpperCase()} /v1/${prefix}${path === '' ? '' : `/${path}`}`,
  );
};

/** The GraphQL fields of the resolver (the method after each `@Query`/`@Mutation`/`@Subscription`). */
const graphqlFields = (): string[] =>
  [
    ...read('domains/ai/src/presentation/graphql/ai.resolver.ts').matchAll(
      /@(?:Query|Mutation|Subscription)\([\s\S]*?\n {2}(?:async )?(\w+)\(/g,
    ),
  ].map((match) => match[1] ?? '');

/** The RPC names of `ai.v1.AiService`. */
const rpcs = (): string[] =>
  [...read('domains/ai/contracts/src/proto/ai/v1/ai.proto').matchAll(/^\s*rpc (\w+)\(/gm)].map(
    (match) => match[1] ?? '',
  );

describe('the lists this spec reads from the code', () => {
  it('are not empty', () => {
    expect(configKeys(AI_CONFIG)).toContain('OPENROUTER_API_KEY');
    expect(configKeys(AI_RATE_LIMIT_CONFIG)).toContain('AI_CHAT_LIMIT');
    expect(configKeys(AI_GRPC_CLIENT_CONFIG)).toEqual(['AI_GRPC_URL', 'AI_GRPC_CHAT_DEADLINE_MS']);
    expect(constValues(LIB_ERRORS, 'AiErrorCode')).toHaveLength(5);
    expect(constValues(CHAT_ERRORS, 'AiChatErrorCode')).toHaveLength(3);
    expect(constValues(TOOLS, 'AiToolName')).toHaveLength(3);
    expect(constValues(TOOLS, 'AiToolErrorCode')).toHaveLength(4);
    expect(restRoutes()).toHaveLength(7);
    expect(graphqlFields()).toHaveLength(8);
    expect(rpcs()).toHaveLength(7);
  });
});

describe('docs/AI.md', () => {
  const ai = existsSync(join(root, 'docs/AI.md')) ? read('docs/AI.md') : '';

  it('covers setup, the OpenRouter key, models, limits, privacy and tools', () => {
    for (const heading of [
      '## Setup',
      '## Models',
      '## Limits',
      '## Privacy',
      '## Tools',
      '## Manual smoke test',
    ]) {
      expect(ai, heading).toContain(`\n${heading}\n`);
    }
  });

  it('names every variable of the ai and aiRateLimit namespaces', () => {
    for (const key of [...configKeys(AI_CONFIG), ...configKeys(AI_RATE_LIMIT_CONFIG)]) {
      expect(ai, key).toContain(`\`${key}\``);
    }
  });

  it('names every error code a chat call can answer with', () => {
    for (const code of [
      ...constValues(LIB_ERRORS, 'AiErrorCode'),
      ...constValues(CHAT_ERRORS, 'AiChatErrorCode'),
    ]) {
      expect(ai, code).toContain(`\`${code}\``);
    }
  });

  it('lists every tool in the tools table and every tool error code', () => {
    const tools = section(ai, '## Tools');
    const cells = firstCells(tools);
    for (const name of constValues(TOOLS, 'AiToolName')) expect(cells, name).toContain(name);
    for (const code of constValues(TOOLS, 'AiToolErrorCode')) {
      expect(tools, code).toContain(`\`${code}\``);
    }
    expect(tools).toContain('AI_TOOLS_SYSTEM_PROMPT');
    expect(flat(tools)).toMatch(/untrusted data/);
  });

  it('names the metrics and states that prompts and completions are never logged', () => {
    for (const metric of METRICS) expect(ai, metric).toContain(`\`${metric}\``);
    expect(flat(section(ai, '## Privacy'))).toMatch(/never logged/);
  });

  it('documents a manual smoke command and that no test calls OpenRouter', () => {
    const smoke = section(ai, '## Manual smoke test');
    expect(smoke).toContain('curl');
    expect(smoke).toContain('/v1/ai/conversations');
    expect(smoke).toContain('AI_ENABLED=true');
    expect(smoke).toContain('OPENROUTER_API_KEY');
    expect(flat(ai)).toMatch(/No test calls OpenRouter/);
  });
});

describe('docs/API.md: the AI surface', () => {
  const api = read('docs/API.md');

  it('lists every REST route of the chat controller', () => {
    const rest = section(api, '## REST endpoints');
    const rows = rest.split('\n').filter((line) => line.startsWith('| `'));
    for (const route of restRoutes()) {
      const [method = '', path = ''] = route.split(' ');
      const row = rows.find(
        (line) => line.includes(`\`${method}\``) && line.includes(`\`${path}\``),
      );
      expect(row, route).toBeDefined();
      expect(row, route).toContain('`ai:chat`');
    }
  });

  it('documents the SSE events and the stream route', () => {
    const stream = section(api, '### AI chat streaming (SSE)');
    for (const event of ['delta', 'done', 'error']) expect(stream, event).toContain(`\`${event}\``);
    expect(stream).toContain('text/event-stream');
  });

  it('lists every GraphQL field of the AI resolver', () => {
    const graphql = section(api, '## GraphQL');
    for (const field of graphqlFields())
      expect(graphql, field).toMatch(new RegExp(`\`${field}\\b`));
  });

  it('lists every RPC of ai.v1.AiService', () => {
    const grpc = section(api, '## gRPC');
    expect(grpc).toContain('`ai.v1.AiService`');
    for (const rpc of rpcs()) expect(grpc, rpc).toContain(`\`${rpc}\``);
    expect(grpc).toContain('ai-service');
  });

  it('lists the send-message route among the idempotency keys', () => {
    expect(section(api, '## Idempotency keys')).toContain(
      '`POST /v1/ai/conversations/:id/messages`',
    );
  });
});

describe('docs/SECURITY.md: the AI permission, rows and tools', () => {
  const security = read('docs/SECURITY.md');

  it('grants ai:chat to members and above in the matrix', () => {
    const row = section(security, '### Matrix (default grants)')
      .split('\n')
      .find((line) => line.includes('`ai:chat`'));
    expect(row?.split('|').map((cell) => cell.trim())).toEqual(
      expect.arrayContaining(['ai', '`ai:chat`', '✓']),
    );
    expect(row?.match(/✓/g)).toHaveLength(3);
  });

  it('names the three ai tables and their row-local policy', () => {
    const rls = section(security, '## Row-level security');
    for (const table of ['ai.conversations', 'ai.messages', 'ai.usage']) {
      expect(rls, table).toContain(`\`${table}\``);
    }
    expect(rls).toContain('user_id = app.user_id()');
  });

  it('documents the tool trust model', () => {
    const tools = section(security, '### AI tools');
    for (const word of ['read-only', 'principal', 'AI_TOOLS_SYSTEM_PROMPT', 'untrusted']) {
      expect(flat(tools), word).toContain(word);
    }
    for (const name of constValues(TOOLS, 'AiToolName')) expect(tools, name).toContain(name);
  });

  it('lists the ai.chat budget in the rate-limit table and ai-service among the trusted services', () => {
    expect(section(security, '## Rate limiting')).toContain('`ai.chat`');
    expect(section(security, '## Internal gRPC (mTLS, reflection)')).toContain('ai');
  });
});

describe('docs/OBSERVABILITY.md: the AI metrics and alert', () => {
  const observability = read('docs/OBSERVABILITY.md');

  it('lists the three metrics in the metrics table', () => {
    const cells = firstCells(section(observability, '### What is exported'));
    for (const metric of METRICS) expect(cells.join(' '), metric).toContain(metric);
  });

  it('documents the alert on the AI error rate and scrapes ai-service', () => {
    expect(section(observability, '### Outbox, ledger and AI alerts')).toContain('`AiErrorRate`');
    expect(section(observability, '### Scrape configuration (local)')).toContain('`ai-service`');
  });
});

describe('docs/CONFIGURATION.md: ai-service and the AI keys', () => {
  const configuration = read('docs/CONFIGURATION.md');

  it('documents every ai key, the gateway client keys and the compose host port in a table row', () => {
    const cells = firstCells(configuration);
    for (const key of [
      ...configKeys(AI_CONFIG),
      ...configKeys(AI_RATE_LIMIT_CONFIG),
      ...configKeys(AI_GRPC_CLIENT_CONFIG),
      'AI_GRPC_HOST_PORT',
    ]) {
      expect(cells, key).toContain(key);
    }
  });

  it('gives ai-service its own column and the aiGrpcClient namespace its row', () => {
    const table = section(configuration, '## Which app loads which namespace');
    expect(table.split('\n').find((line) => line.startsWith('| Namespace'))).toContain(
      'ai-service',
    );
    expect(firstCells(table)).toContain('aiGrpcClient');
  });

  it('says which URL ai-service needs', () => {
    expect(section(configuration, '#### Which process needs which URL')).toContain('`ai-service`');
  });
});

describe('README.md: the AI feature', () => {
  const readme = read('README.md');

  it('links docs/AI.md and lists ai-service, @domain/ai and @platform/ai', () => {
    expect(readme).toContain('[docs/AI.md](docs/AI.md)');
    expect(section(readme, '## Ports')).toContain('ai');
    const layout = section(readme, '## Repository layout');
    for (const path of ['ai-service/', 'ai/']) expect(layout, path).toContain(path);
    expect(readme).toContain('[ai-service](apps/ai-service/README.md)');
    expect(readme).toContain('[ai](domains/ai/README.md)');
  });
});
