# @app/mailer

Templated transactional mail. `MailService.enqueue()` puts a mail on the BullMQ `mail` queue, so
the caller (an HTTP request or a Kafka consumer) doesn't wait on SMTP. `MailProcessor` renders the
Handlebars template and sends it over pooled SMTP, retrying with exponential backoff. Idempotency
keys make redelivered events safe.

## Public API

| Export                                                                                                                                                                                                 | Kind          | Purpose                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppMailerModule.forRootAsync(options?: { worker?: boolean })`                                                                                                                                         | global module | `MailerModule` (SMTP + Handlebars), `BullModule.registerQueue({ name: 'mail' })`, `MailService`, and `MailProcessor` unless `worker: false`.                                                      |
| `MailService`                                                                                                                                                                                          | provider      | `enqueue(mail: MailMessage): Promise<EnqueuedMail>` (job id = idempotency key), `sendNow(mail: MailMessage \| MailJobData): Promise<void>` (render + send in-process, no retry).                  |
| `MailProcessor`                                                                                                                                                                                        | BullMQ worker | `@Processor('mail')`. Applies `MAIL_QUEUE_CONCURRENCY` at bootstrap, marks permanent failures `UnrecoverableError`, and logs retries (warn) and final failures (error) with the recipient masked. |
| `MailMessage`                                                                                                                                                                                          | type          | `{ to, subject, template: MailTemplate, context: Record<string, unknown>, idempotencyKey? }`                                                                                                      |
| `MailJobData`, `EnqueuedMail`                                                                                                                                                                          | types         | Job payload (`MailMessage` without the key); `{ jobId }`.                                                                                                                                         |
| `WelcomeMailContext`, `PaymentReceiptMailContext`, `DailyDigestMailContext`, `DigestItem`, `BaseMailContext`, `MailTemplateContextMap`                                                                 | types         | What each template reads.                                                                                                                                                                         |
| `defineMail<T>(mail)`                                                                                                                                                                                  | function      | Builds a `MailMessage` whose context is type-checked against template `T`.                                                                                                                        |
| `formatMoney(amountMinor, currency, locale = 'en-US')`                                                                                                                                                 | function      | Minor units → localized string with the right decimals (`1999, 'usd'` → `$19.99`).                                                                                                                |
| `toMailJobId(key)`, `mailFromName(from)`, `defaultMailContext(from, now?)`                                                                                                                             | functions     | BullMQ-safe job ids; the `MAIL_FROM` display name; `{ appName, year }`.                                                                                                                           |
| `isPermanentMailError(error)`                                                                                                                                                                          | function      | Handlebars errors, SMTP 5xx, `EENVELOPE`/`ENOENT`/`EMESSAGE` → `true`.                                                                                                                            |
| `createMailerOptions(cfg)`, `registerMailPartials(dir?)`, `SMTP_TIMEOUTS`, `MAIL_SEND_TIMEOUT_MS`                                                                                                      | factory       | `MailerOptions` from the `mail` config namespace.                                                                                                                                                 |
| `MAIL_QUEUE` (`'mail'`), `MAIL_TEMPLATES`, `MailTemplate`, `MAIL_TEMPLATES_DIR`, `MAIL_PARTIALS_DIR`, `MAIL_JOB_OPTIONS`, `DEFAULT_MAIL_CONCURRENCY`, `DEFAULT_MAIL_APP_NAME`, `MAIL_TEMPLATE_HELPERS` | constants     |                                                                                                                                                                                                   |

Templates (`src/templates`, copied to `dist/templates` by SWC `copyFiles`):

| Template          | Required context                                     | Optional context                       |
| ----------------- | ---------------------------------------------------- | -------------------------------------- |
| `welcome`         | `displayName`                                        | `appUrl`                               |
| `payment-receipt` | `paymentId`, `amount` (pre-formatted), `paidAt`      | `displayName`, `description`, `appUrl` |
| `daily-digest`    | `unreadCount`, `items: { title, body, createdAt }[]` | `displayName`, `appUrl`                |

Every template also gets `appName` (the display name of `MAIL_FROM`) and `year`. Callers can
override both. Partials: `header` (`title`, `preheader`), `footer`, `button` (`url`, `label`).
Helpers: `concat`, `plural`.

## Usage

```ts
// notifications-service / monolith (they deliver mail)
imports: [AppQueueModule.forRootAsync(), AppMailerModule.forRootAsync()];
// an edge process that only enqueues
imports: [AppQueueModule.forRootAsync(), AppMailerModule.forRootAsync({ worker: false })];

// Kafka consumer: redelivery-safe
await this.mail.enqueue(
  defineMail({
    to: event.payload.email,
    subject: 'Welcome!',
    template: 'welcome',
    context: { displayName: event.payload.displayName },
    idempotencyKey: `welcome-${event.payload.userId}`,
  }),
);
```

## Environment (`mail` namespace)

`SMTP_HOST` (localhost), `SMTP_PORT` (1025, Mailpit), `SMTP_SECURE` (false), `SMTP_USER` +
`SMTP_PASSWORD` (set both or neither), `MAIL_FROM`, `SMTP_POOL` (true), `SMTP_MAX_CONNECTIONS` (5),
`MAIL_QUEUE_CONCURRENCY` (5). The Redis connection comes from `AppQueueModule` (`REDIS_URL`).

## Gotchas

- **`AppQueueModule.forRootAsync()` (from `@app/redis`) must be imported at the app level.**
  `BullModule.registerQueue` needs the global BullMQ connection.
- **Idempotency lasts 24h.** A custom `jobId` deduplicates only while the job exists. Completed
  mail jobs are kept for 24h (`MAIL_JOB_OPTIONS.removeOnComplete`). Keys that BullMQ would reject
  (containing `:`, or integer strings) are hashed to `k-<sha256>` instead of being rejected.
- **Strict Handlebars.** `{{unknown}}` throws, and the job fails as unrecoverable (no retries). Use
  `{{#if x}}` for optional values. Helper arguments are not checked by strict mode.
- `@nestjs-modules/mailer` quirks (see research integrations §3): its typings require the `imports`
  key in `forRootAsync`; `defaults` needs a cast for nodemailer 10's bundled types; it
  `require('lodash')` without declaring it (hence the `lodash` dependency); its ESM adapter path is
  `@nestjs-modules/mailer/adapters/handlebars.adapter`.
- Partials are precompiled and registered once, when `createMailerOptions` runs at boot
  (`registerMailPartials`, on the global Handlebars env that the adapter renders with). The
  adapter's own `options.partials` is deliberately not used: it globs, re-reads and re-registers
  every partial synchronously on every send.
- BullMQ prints `error` events nobody listens to with `console.error` (raw stacks, outside pino,
  one per reconnect attempt). `MailService` (queue) and `MailProcessor` (worker) listen and log
  them through the Nest logger, throttled to one line per 5 s (`createThrottledErrorLog`).
  `MailService` attaches its listener in the constructor: with Redis down at boot the queue
  errors before any `onModuleInit` hook runs.
- CSS inlining is disabled because the templates are already inline-styled. Email clients strip
  `<style>` blocks.
- SMTP timeouts are lowered from nodemailer's defaults (2 min connect, 10 min idle socket), so a
  stuck server can't pin worker slots.
