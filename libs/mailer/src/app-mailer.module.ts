import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { type MailConfig, mailConfig } from '@platform/config';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';
import { MAIL_QUEUE } from './mailer.constants.js';
import { createMailerOptions } from './mailer-options.factory.js';

export interface AppMailerModuleOptions {
  /**
   * Folders of `*.hbs` mail templates, one per domain whose mails this process renders (each domain
   * exports its folder, e.g. `ORDERS_MAIL_TEMPLATES_DIR`). A template is looked up by file name in
   * each folder, in order. A missing folder or a name defined twice fails at boot. The shared layout
   * partials (`header`, `footer`, `button`) come from this package. `[]` is only valid with
   * `worker: false` (the process enqueues; other processes render and send).
   */
  templateDirs: readonly string[];
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
 * Requires the app-level BullMQ connection (`AppQueueModule.forRootAsync()` from `@platform/redis`),
 * which `BullModule.registerQueue` resolves globally.
 */
@Module({})
export class AppMailerModule {
  static forRootAsync(options: AppMailerModuleOptions): DynamicModule {
    const worker = options.worker ?? true;
    if (worker && options.templateDirs.length === 0) {
      throw new Error(
        'AppMailerModule: a process that delivers mail (worker) needs at least one template dir',
      );
    }
    const providers: Provider[] = [MailService];
    if (worker) providers.push(MailProcessor);
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
          useFactory: (cfg: MailConfig) => createMailerOptions(cfg, options.templateDirs),
        }),
        BullModule.registerQueue({ name: MAIL_QUEUE }),
      ],
      providers,
      exports: [MailService],
    };
  }
}
