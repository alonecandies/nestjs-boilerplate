import { type AppConfig, appConfig } from '@app/config';
import { type INestApplication, Logger } from '@nestjs/common';

export interface ListenOptions {
  /** Default `appConfig.host` (`HOST`, 0.0.0.0). */
  host?: string;
  /** Default `appConfig.port` (`PORT`); `0` picks a free port (tests). */
  port?: number;
}

/**
 * Starts the HTTP server on `HOST`/`PORT` from the `app` config and logs where it listens.
 * Returns the URL (useful for tests binding port 0).
 */
export async function listen(app: INestApplication, options: ListenOptions = {}): Promise<string> {
  const config = app.get<string, AppConfig>(appConfig.KEY);
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  await app.listen(port, host);
  const url = await app.getUrl();
  new Logger('Bootstrap').log(
    `${config.serviceName} listening on ${url} (pid ${process.pid}, ${config.nodeEnv})`,
  );
  return url;
}
