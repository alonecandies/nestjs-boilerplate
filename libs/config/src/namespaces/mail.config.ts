import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zPort, zStr } from '../env/env.helpers.js';
import { isLoopbackHost } from '../env/production-guards.js';

/** Reserved example/test domains (RFC 2606, RFC 6761): mail sent "from" them is undeliverable. */
const RESERVED_SENDER_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/** Domain of `Name <user@domain>` or `user@domain`. */
const senderDomain = (from: string): string | undefined => /@([^>\s]+)>?\s*$/.exec(from)?.[1];

export const mailEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    SMTP_HOST: zStr('localhost'),
    SMTP_PORT: zPort(1025),
    SMTP_SECURE: zBool(false),
    // Refuse to send unless STARTTLS succeeds (nodemailer `requireTLS`). Default: on in production
    // unless SMTP_SECURE (implicit TLS) or SMTP_ALLOW_INSECURE.
    SMTP_REQUIRE_TLS: zBool(),
    SMTP_USER: zStr(),
    SMTP_PASSWORD: zStr(),
    MAIL_FROM: zStr('NestJS Boilerplate <no-reply@example.com>'),
    SMTP_POOL: zBool(true),
    SMTP_MAX_CONNECTIONS: zInt(5, { min: 1 }),
    MAIL_QUEUE_CONCURRENCY: zInt(5, { min: 1 }),
    // LOCAL compose stack only: Mailpit is plaintext and the default sender is example.com.
    SMTP_ALLOW_INSECURE: zBool(false),
  })
  .superRefine((env, ctx) => {
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SMTP_USER === undefined ? 'SMTP_USER' : 'SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be set together',
      });
    }
    if (env.NODE_ENV !== 'production' || env.SMTP_ALLOW_INSECURE) return;
    if (isLoopbackHost(env.SMTP_HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message:
          'SMTP_HOST points at this machine (the Mailpit default): set your mail provider in production, or SMTP_ALLOW_INSECURE=true for the local compose stack only',
      });
    }
    const domain = senderDomain(env.MAIL_FROM);
    if (domain === undefined || RESERVED_SENDER_DOMAIN.test(domain)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message:
          'MAIL_FROM must use a domain you send from in production (example.com and other reserved domains are undeliverable), or set SMTP_ALLOW_INSECURE=true for the local compose stack only',
      });
    }
    if (!env.SMTP_SECURE && env.SMTP_REQUIRE_TLS === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_REQUIRE_TLS'],
        message:
          'SMTP_REQUIRE_TLS=false with SMTP_SECURE=false sends credentials and mail in plaintext whenever the server offers no STARTTLS: keep it on in production, or set SMTP_ALLOW_INSECURE=true for the local compose stack only',
      });
    }
  })
  .transform((env) => ({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    /** `true` = implicit TLS (port 465); `false` = STARTTLS upgrade, mandatory when `requireTls`. */
    secure: env.SMTP_SECURE,
    requireTls:
      env.SMTP_REQUIRE_TLS ??
      (env.NODE_ENV === 'production' && !env.SMTP_SECURE && !env.SMTP_ALLOW_INSECURE),
    /** nodemailer's `auth` shape. */
    auth:
      env.SMTP_USER !== undefined && env.SMTP_PASSWORD !== undefined
        ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
        : undefined,
    from: env.MAIL_FROM,
    /** Reuse SMTP connections instead of a TLS handshake per mail. */
    pool: env.SMTP_POOL,
    maxConnections: env.SMTP_MAX_CONNECTIONS,
    queueConcurrency: env.MAIL_QUEUE_CONCURRENCY,
  }));

/** Outbound mail (SMTP via nodemailer, BullMQ-queued). */
export const mailConfig = defineConfigNamespace('mail', mailEnvSchema);
export type MailConfig = ConfigType<typeof mailConfig>;
