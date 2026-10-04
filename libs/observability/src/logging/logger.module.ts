import {
  type AppConfig,
  appConfig,
  type ObservabilityConfig,
  observabilityConfig,
} from '@app/config';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from './logger-params.js';

/**
 * nestjs-pino wiring (internal to `ObservabilityModule`). `LoggerModule` is global, so `Logger`
 * (for `app.useLogger`) and `PinoLogger` / `@InjectPinoLogger()` resolve everywhere; `appConfig`
 * and `observabilityConfig` are provided globally by `AppConfigModule.forRoot()`.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [observabilityConfig.KEY, appConfig.KEY],
      useFactory: (observability: ObservabilityConfig, app: AppConfig) =>
        buildLoggerParams(observability, app),
    }),
  ],
})
export class AppLoggerModule {}
