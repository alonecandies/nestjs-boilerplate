import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zPort, zStr } from '../env/env.helpers.js';

export const mailEnvSchema = z
  .object({
    SMTP_HOST: zStr('localhost'),
    SMTP_PORT: zPort(1025),
    SMTP_SECURE: zBool(false),
    SMTP_USER: zStr(),
    SMTP_PASSWORD: zStr(),
    MAIL_FROM: zStr('NestJS Boilerplate <no-reply@example.com>'),
    SMTP_POOL: zBool(true),
    SMTP_MAX_CONNECTIONS: zInt(5, { min: 1 }),
    MAIL_QUEUE_CONCURRENCY: zInt(5, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SMTP_USER === undefined ? 'SMTP_USER' : 'SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be set together',
      });
    }
  })
  .transform((env) => ({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    /** `true` = implicit TLS (port 465); `false` = STARTTLS upgrade when offered. */
    secure: env.SMTP_SECURE,
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
