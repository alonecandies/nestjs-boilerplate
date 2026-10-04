import { Body, Controller, Get, HttpCode, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFastifyTestApp } from './create-test-app.js';

@Controller('pings')
class PingController {
  @Get()
  list(): { pong: true } {
    return { pong: true };
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: { value: number }): { echoed: number } {
    return { echoed: body.value };
  }
}

@Controller({ path: 'health', version: VERSION_NEUTRAL })
class HealthController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}

describe('createFastifyTestApp', () => {
  let app: NestFastifyApplication;
  // A plain closure, not vi.fn(): the root config's `clearMocks` would wipe calls made in beforeAll.
  let configuredWith: NestFastifyApplication | undefined;
  const configure = async (instance: NestFastifyApplication): Promise<void> => {
    configuredWith = instance;
    instance
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', async (_req, reply) => {
        reply.header('x-configured', 'yes');
      });
  };

  beforeAll(async () => {
    app = await createFastifyTestApp(
      Test.createTestingModule({ controllers: [PingController, HealthController] }),
      configure,
      { adapter: new FastifyAdapter({ bodyLimit: 1024 }), appOptions: { logger: false } },
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it('boots a ready Fastify app with URI versioning defaulting to v1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/pings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
    expect((await app.inject({ method: 'GET', url: '/pings' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });

  it('runs configure() before init and honours the custom adapter', async () => {
    expect(configuredWith).toBe(app);
    const ok = await app.inject({ method: 'POST', url: '/v1/pings', payload: { value: 7 } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ echoed: 7 });
    expect(ok.headers['x-configured']).toBe('yes');
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/v1/pings',
      payload: { value: 'x'.repeat(2048) },
    });
    expect(tooLarge.statusCode).toBe(413);
  });
});
