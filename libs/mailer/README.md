# @platform/mailer

Templated transactional mail. `MailService.enqueue()` puts a mail on the BullMQ `mail` queue, so
the caller (an HTTP request or a Kafka consumer) doesn't wait on SMTP. `MailProcessor` renders the
Handlebars template and sends it over pooled SMTP, retrying with exponential backoff. Idempotency
keys make redelivered events safe.

## Public API

| Export                                                                                                                                                                                                                         | Kind          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppMailerModule.forRootAsync({ templateDirs, worker? })`                                                                                                                                                                      | global module | `MailerModule` (SMTP + Handlebars over the given template folders), `BullModule.registerQueue({ name: 'mail' })`, `MailService`, and `MailProcessor` unless `worker: false`. A worker needs at least one template folder.                                                                                                                                                                                                                                                           |
| `MailService`                                                                                                                                                                                                                  | provider      | `enqueue(mail: MailMessage, retention?: MailJobRetention): Promise<EnqueuedMail>` (job id = idempotency key; `retention` such as `{ removeOnComplete: true, removeOnFail: true }` deletes a job whose data is a secret as soon as it is sent or gives up), `sendNow(mail: MailMessage \| MailJobData): Promise<void>` (render + send in-process, no retry).                                                                                                                         |
| `MailProcessor`                                                                                                                                                                                                                | BullMQ worker | `@Processor('mail')`. Applies `MAIL_QUEUE_CONCURRENCY` at bootstrap, marks permanent failures `UnrecoverableError`, logs retries (warn) and final failures (error) with the recipient masked, and counts `mail_jobs_total{outcome}`: `sent`, `retried` (failed, attempts left) or `failed` (out of attempts or a permanent error). The three series start at 0, and the `MailJobsFailed` alert pages a ticket on the first `failed` (`docker/prometheus/rules/platform.rules.yml`). |
| `MailMessage<TTemplate extends string = string>`                                                                                                                                                                               | type          | `{ to, subject, template: TTemplate, context: Record<string, unknown>, idempotencyKey? }`                                                                                                                                                                                                                                                                                                                                                                                           |
| `MailJobData`, `EnqueuedMail`                                                                                                                                                                                                  | types         | Job payload (`MailMessage` without the key); `{ jobId }`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BaseMailContext`, `MailJobRetention`, `TypedMailMessage<TContextMap, TTemplate>`                                                                                                                                              | types         | Variables every template gets (`appName`, `year`, `appUrl`); a mail whose context is checked against a domain's template map.                                                                                                                                                                                                                                                                                                                                                       |
| `defineMail<TContextMap>()`                                                                                                                                                                                                    | function      | Returns a `MailMessage` builder that type-checks `context` against `TContextMap[template]`. Each domain binds its own.                                                                                                                                                                                                                                                                                                                                                              |
| `formatMoney(amountMinor, currency, locale = 'en-US')`                                                                                                                                                                         | function      | Minor units → localized string with the right decimals (`1999, 'usd'` → `$19.99`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `toMailJobId(key)`, `mailFromName(from)`, `defaultMailContext(from, now?, appUrl?)`                                                                                                                                            | functions     | BullMQ-safe job ids; the `MAIL_FROM` display name; `{ appName, year, appUrl? }`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isPermanentMailError(error)`                                                                                                                                                                                                  | function      | Handlebars errors, SMTP 5xx, `EENVELOPE`/`ENOENT`/`EMESSAGE` → `true`. `ENOENT` is a missing file such as an attachment: an unknown template name is a retried `TypeError` (see Gotchas).                                                                                                                                                                                                                                                                                           |
| `createMailerOptions(cfg, templateDirs = [])`, `listMailTemplates(templateDirs)`, `registerMailPartials(dir?)`, `SMTP_TIMEOUTS`, `MAIL_SEND_TIMEOUT_MS`                                                                        | factory       | `MailerOptions` from the `mail` namespace and the template folders; the template names (fails on a missing folder or a duplicate name).                                                                                                                                                                                                                                                                                                                                             |
| `MAIL_QUEUE` (`'mail'`), `MAIL_JOBS_TOTAL` (`'mail_jobs_total'`), `MailJobOutcome`, `MAIL_JOB_OUTCOMES`, `MAIL_PARTIALS_DIR`, `MAIL_JOB_OPTIONS`, `DEFAULT_MAIL_CONCURRENCY`, `DEFAULT_MAIL_APP_NAME`, `MAIL_TEMPLATE_HELPERS` | constants     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Templates

This package ships no mail templates, only the layout partials (`src/templates/partials`, copied to `dist` by SWC `copyFiles`): `header` (`title`, `preheader`), `footer` and `button` (`url`, `label`). Helpers: `concat`, `plural`. Every template gets `appName` (the display name of `MAIL_FROM`) and `year`; callers can override both.

Each domain that sends mail owns its templates and their context types:

- a folder of `*.hbs` files next to its code, exported as `<DOMAIN>_MAIL_TEMPLATES_DIR`;
- a template → context map;
- a builder bound with `defineMail<TheMap>()`.

The app that renders those mails registers the folder. Names are looked up in the registered folders in order. A missing folder or a name defined by two folders fails at boot.

## Usage

```ts
// the domain (e.g. @domain/orders)
export const ORDERS_MAIL_TEMPLATES_DIR = join(import.meta.dirname, 'templates'); // order-confirmed.hbs
export interface OrdersMailContextMap {
  'order-confirmed': BaseMailContext & { orderId: string; total: string };
}
export const defineOrdersMail = defineMail<OrdersMailContextMap>();

// a process that delivers mail registers the folder of every domain it renders
imports: [
  AppQueueModule.forRootAsync(),
  AppMailerModule.forRootAsync({ templateDirs: [ORDERS_MAIL_TEMPLATES_DIR] }),
];
// an edge process that only enqueues
imports: [
  AppQueueModule.forRootAsync(),
  AppMailerModule.forRootAsync({ templateDirs: [], worker: false }),
];

// Kafka consumer: redelivery-safe
await this.mail.enqueue(
  defineOrdersMail({
    to: event.payload.email,
    subject: 'Order confirmed',
    template: 'order-confirmed',
    context: {
      orderId: event.payload.orderId,
      total: formatMoney(event.payload.totalMinor, 'usd'),
    },
    idempotencyKey: `order-confirmed-${event.payload.orderId}`,
  }),
);
```

## Environment (`mail` namespace)

`SMTP_HOST` (localhost), `SMTP_PORT` (1025, Mailpit), `SMTP_SECURE` (false), `SMTP_USER` +
`SMTP_PASSWORD` (set both or neither), `MAIL_FROM`, `SMTP_POOL` (true), `SMTP_MAX_CONNECTIONS` (5),
`MAIL_QUEUE_CONCURRENCY` (5), `MAIL_APP_URL` (optional http(s) URL, https in production unless
`SMTP_ALLOW_INSECURE`; trailing slash dropped). `MAIL_APP_URL` becomes `appUrl` in every template's
context (`sendNow` merges it under the caller's context), so the welcome, receipt and digest buttons
render. The Redis connection comes from `AppQueueModule` (`REDIS_URL`).

## Gotchas

- **`AppQueueModule.forRootAsync()` (from `@platform/redis`) must be imported at the app level.**
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
- **A template name that no registered folder defines** makes `sendMail` reject with
  `TypeError: Cannot destructure property 'templateName' of 'precompile(...)' as it is undefined.`
  (`@nestjs-modules/mailer` 2.3.7 reports the failed file read through a callback, then
  destructures what `precompile` returned). `isPermanentMailError` does not treat that `TypeError`
  as permanent, so BullMQ retries the job until its attempts run out. The underlying `ENOENT` also
  surfaces as an unhandled rejection, which the apps' `installProcessHandlers` logs as fatal before
  exiting the process. Nothing hangs or times out. Boot already fails on a missing folder or a
  duplicate name. Build mails with the owning domain's `defineMail` builder so names are
  type-checked.
