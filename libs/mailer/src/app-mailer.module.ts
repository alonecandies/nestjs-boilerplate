import { mailConfig } from '@app/config';
import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';
import { MAIL_QUEUE } from './mailer.constants.js';
import { createMailerOptions } from './mailer-options.factory.js';

export interface AppMailerModuleOptions {
  /**
   * Register `MailProcessor` in this process. Default `true`. Set `false` in processes that only
   * enqueue (API edge) so mail is delivered by dedicated workers.
   */
  worker?: boolean;
}

/**
 * Global outbound mail: `MailerModule` (pooled SMTP + Handlebars templates), the `mail` BullMQ
 * queue, `MailService`, and optionally the `MailProcessor` worker.
 *
 * Requires the app-level BullMQ connection (`AppQueueModule.forRootAsync()` from `@app/redis`),
 * which `BullModule.registerQueue` resolves globally.
 */
@Module({})
export class AppMailerModule {
  static forRootAsync(options: AppMailerModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [MailService];
    if (options.worker ?? true) providers.push(MailProcessor);
    return {
      module: AppMailerModule,
      global: true,
      imports: [
        ConfigModule.forFeature(mailConfig),
        MailerModule.forRootAsync({
          // `imports` is a REQUIRED key: the mailer's d.ts deep-imports `@nestjs/common/interfaces`,
          // which Nest 12's exports map no longer resolves. It must list the config namespace
          // anyway, so that `mailConfig.KEY` is injectable inside the mailer's own module.
          imports: [ConfigModule.forFeature(mailConfig)],
          inject: [mailConfig.KEY],
          useFactory: createMailerOptions,
        }),
        BullModule.registerQueue({ name: MAIL_QUEUE }),
      ],
      providers,
      exports: [MailService],
    };
  }
}
