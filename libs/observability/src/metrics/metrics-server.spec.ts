import {
  type MetricsRequest,
  type MetricsServer,
  scrapeMetrics,
  startMetricsServer,
} from './metrics-server.js';

const collect = async (): Promise<string> => '# HELP up 1\nup 1\n';
const request = (overrides: Partial<MetricsRequest> = {}): MetricsRequest => ({
  method: 'GET',
  url: '/metrics',
  authorization: undefined,
  ...overrides,
});

describe('scrapeMetrics', () => {
  it('answers GET /metrics with the collected text', async () => {
    const scrape = await scrapeMetrics({ collect }, request());
    expect(scrape).toMatchObject({ status: 200, body: '# HELP up 1\nup 1\n' });
    expect(scrape.contentType).toMatch(/^text\/plain/);
    expect((await scrapeMetrics({ collect }, request({ url: '/metrics?x=1' }))).status).toBe(200);
  });

  it.each([
    ['POST', '/metrics'],
    ['GET', '/'],
    ['GET', '/metrics/x'],
    ['GET', '/health/live'],
  ])('answers %s %s with 404', async (method, url) => {
    expect((await scrapeMetrics({ collect }, request({ method, url }))).status).toBe(404);
  });

  it('answers 404 to a missing or wrong bearer token, like a disabled endpoint', async () => {
    const options = { collect, bearerToken: 'a-long-enough-secret' };
    expect((await scrapeMetrics(options, request())).status).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'Bearer wrong-secret-value' })))
        .status,
    ).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'Basic a-long-enough-secret' })))
        .status,
    ).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'bearer  a-long-enough-secret ' })))
        .status,
    ).toBe(200);
  });

  it('answers 500 when collection throws', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('registry broke');
    };
    const scrape = await scrapeMetrics({ collect: failing }, request());
    expect(scrape.status).toBe(500);
    expect(scrape.body).not.toContain('registry broke');
  });
});

// Binds 127.0.0.1: run with the sandbox off.
describe('startMetricsServer', () => {
  const servers: MetricsServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  const start = async (port = 0): Promise<MetricsServer> => {
    const server = await startMetricsServer({ port, host: '127.0.0.1', collect });
    servers.push(server);
    return server;
  };

  it('serves /metrics over HTTP (GET and HEAD) and 404 elsewhere', async () => {
    const server = await start();
    const ok = await fetch(`${server.url}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toContain('up 1');
    const head = await fetch(`${server.url}/metrics`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${server.url}/`)).status).toBe(404);
  });

  it('rejects when the port is taken: the boot fails instead of serving nothing', async () => {
    const first = await start();
    await expect(start(Number(new URL(first.url).port))).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
