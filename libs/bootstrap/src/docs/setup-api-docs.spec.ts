import { AppConfigModule } from '@app/config';
import { ObservabilityModule } from '@app/observability';
import { Controller, Get, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiOkResponse } from '@nestjs/swagger';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../http/create-http-app.js';
import { OPENAPI_JSON_PATH, setupApiDocs } from './setup-api-docs.js';

process.env['LOG_LEVEL'] = 'silent';

@Controller('things')
class ThingsController {
  @Get()
  @ApiOkResponse({ description: 'All things' })
  list(): string[] {
    return ['a'];
  }
}

@Module({
  imports: [AppConfigModule.forRoot(), ObservabilityModule.forRoot({ observe: false })],
  controllers: [ThingsController],
})
class DocsModule {}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { operationId?: string; tags?: string[] }>>;
  components?: { securitySchemes?: Record<string, { type: string; scheme?: string }> };
}

describe('setupApiDocs', () => {
  let app: NestFastifyApplication | undefined;

  async function boot(
    enabled?: boolean,
  ): Promise<{ app: NestFastifyApplication; mounted: boolean }> {
    const created = await createHttpApp(DocsModule, { processHandlers: false });
    app = created;
    const mounted = setupApiDocs(created, {
      title: 'Test API',
      version: '2.3.4',
      ...(enabled === undefined ? {} : { enabled }),
    });
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    return { app: created, mounted };
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves /openapi.json with the app routes, bearer auth and stable operation ids', async () => {
    const { app: docsApp, mounted } = await boot();
    expect(mounted).toBe(true);

    const response = await docsApp.inject({ method: 'GET', url: OPENAPI_JSON_PATH });
    expect(response.statusCode).toBe(200);
    const document = response.json<OpenApiDocument>();

    expect(document.info).toEqual({
      title: 'Test API',
      version: '2.3.4',
      description: '',
      contact: {},
    });
    expect(document.paths['/v1/things']?.['get']).toMatchObject({
      operationId: 'Things_list',
      tags: ['Things'],
    });
    expect(document.components?.securitySchemes?.['bearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('keeps ops endpoints out of the public contract', async () => {
    const { app: docsApp } = await boot();
    const document = (
      await docsApp.inject({ method: 'GET', url: OPENAPI_JSON_PATH })
    ).json<OpenApiDocument>();
    expect(Object.keys(document.paths)).toEqual(['/v1/things']);
  });

  it('serves YAML and the Scalar reference with a route-level CSP', async () => {
    const { app: docsApp } = await boot();

    const yaml = await docsApp.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.body).toContain('openapi: 3');

    const docs = await docsApp.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(docs.body).toContain('/openapi.json');
    expect(docs.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');

    // The global CSP stays strict for API routes.
    const api = await docsApp.inject({ method: 'GET', url: '/v1/things' });
    expect(api.headers['content-security-policy']).not.toContain('cdn.jsdelivr.net');
  });

  it('is a no-op when docs are disabled', async () => {
    const { app: docsApp, mounted } = await boot(false);
    expect(mounted).toBe(false);
    expect((await docsApp.inject({ method: 'GET', url: OPENAPI_JSON_PATH })).statusCode).toBe(404);
    expect((await docsApp.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });
});
