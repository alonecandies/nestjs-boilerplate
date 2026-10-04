import { type AppConfig, appConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { omitBy, once } from 'lodash-es';
import { DOCS_CONTENT_SECURITY_POLICY } from '../http/security.js';

export interface ApiDocsOptions {
  title: string;
  description?: string;
  /** API version shown in the document. Default `1.0.0`. */
  version?: string;
  /** Scalar UI route. Default `/docs`. */
  path?: string;
  /** Path prefixes left out of the public contract. Default `['/health', '/metrics']`. */
  excludePathPrefixes?: readonly string[];
  /** Hook to add servers, tags, extra security schemes… before the document is built. */
  configure?: (builder: DocumentBuilder) => DocumentBuilder;
  /** Override `DOCS_ENABLED` (default: on unless NODE_ENV=production). */
  enabled?: boolean;
}

export const OPENAPI_JSON_PATH = '/openapi.json';
export const OPENAPI_YAML_PATH = '/openapi.yaml';

type ScalarHandler = (request: unknown, response: { send(html: string): unknown }) => void;

/** `UsersController.findOne` → `Users_findOne`: stable ids for generated clients. */
const operationIdFactory = (controllerKey: string, methodKey: string): string =>
  `${controllerKey.replace(/Controller$/, '')}_${methodKey}`;

/** Scalar renders the same static HTML on every call; render it once at setup instead. */
function renderScalarHtml(title: string): string {
  let html = '';
  const handler = apiReference({
    url: OPENAPI_JSON_PATH,
    pageTitle: `${title} — API Reference`,
    metaData: { title: `${title} — API Reference` },
    persistAuth: true,
    hideClientButton: false,
  }) as unknown as ScalarHandler;
  handler(undefined, {
    send: (body: string) => {
      html = body;
    },
  });
  return html;
}

function withoutPrefixes(document: OpenAPIObject, prefixes: readonly string[]): OpenAPIObject {
  const excluded = (path: string): boolean =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return { ...document, paths: omitBy(document.paths, (_item, path) => excluded(path)) };
}

/**
 * OpenAPI + interactive reference, off in production unless `DOCS_ENABLED=true`:
 * - `GET /openapi.json` / `GET /openapi.yaml` — built lazily on the first request, then cached;
 *   bearer (JWT) auth scheme, controller-derived tags and operation ids; ops routes excluded.
 * - `GET /docs` — Scalar API reference as a native Fastify route with its own route-level CSP (the
 *   global CSP forbids the CDN assets it needs). Uses `reply.send`, not `reply.hijack()`, so
 *   helmet/compress headers still apply (research nest-http §3.2, GOTCHA 17).
 *
 * Call after `createHttpApp()` (helmet must be registered first: it maps route-level options when
 * the route is added) and before `listen()`. Returns whether the docs were mounted.
 */
export function setupApiDocs(app: NestFastifyApplication, options: ApiDocsOptions): boolean {
  const config = app.get<string, AppConfig>(appConfig.KEY);
  if (!(options.enabled ?? config.docsEnabled)) return false;

  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setVersion(options.version ?? '1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  if (options.description !== undefined) builder.setDescription(options.description);
  const documentConfig = (options.configure?.(builder) ?? builder).build();
  const excluded = options.excludePathPrefixes ?? ['/health', '/metrics'];

  const documentFactory = once(() =>
    withoutPrefixes(
      SwaggerModule.createDocument(app, documentConfig, {
        operationIdFactory,
        autoTagControllers: true,
      }),
      excluded,
    ),
  );
  SwaggerModule.setup('swagger', app, documentFactory, {
    ui: false,
    raw: ['json', 'yaml'],
    jsonDocumentUrl: OPENAPI_JSON_PATH.slice(1),
    yamlDocumentUrl: OPENAPI_YAML_PATH.slice(1),
  });

  const docsPath = options.path ?? '/docs';
  const html = renderScalarHtml(options.title);
  app
    .getHttpAdapter()
    .getInstance()
    .get(
      docsPath,
      { helmet: { contentSecurityPolicy: DOCS_CONTENT_SECURITY_POLICY } },
      (_request, reply) => reply.type('text/html; charset=utf-8').send(html),
    );

  new Logger('ApiDocs').log(`API docs at ${docsPath} (${OPENAPI_JSON_PATH}, ${OPENAPI_YAML_PATH})`);
  return true;
}
