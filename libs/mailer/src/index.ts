/**
 * @app/mailer — templated transactional mail. `MailService.enqueue()` puts a mail on the BullMQ
 * `mail` queue (idempotent by key); `MailProcessor` renders the Handlebars template (strict mode,
 * shared partials) and sends it over pooled SMTP with retries and backoff.
 */
export * from './app-mailer.module.js';
export * from './mail.errors.js';
export * from './mail.processor.js';
export * from './mail.service.js';
export * from './mail.types.js';
export * from './mail.util.js';
export * from './mail-template.helpers.js';
export * from './mailer.constants.js';
export * from './mailer-options.factory.js';
