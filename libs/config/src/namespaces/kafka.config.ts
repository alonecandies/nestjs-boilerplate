import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zCsv, zEnum, zInt, zServiceName, zStr } from '../env/env.helpers.js';

export const KAFKA_SASL_MECHANISMS = ['plain', 'scram-sha-256', 'scram-sha-512'] as const;
export type KafkaSaslMechanism = (typeof KAFKA_SASL_MECHANISMS)[number];

export const kafkaEnvSchema = z
  .object({
    SERVICE_NAME: zServiceName(),
    KAFKA_BROKERS: zCsv('localhost:9094', { nonEmpty: true }),
    KAFKA_CLIENT_ID: zStr(),
    KAFKA_GROUP_ID: zStr(),
    KAFKA_CONSUMER_CONCURRENCY: zInt(3, { min: 1, max: 1000 }),
    KAFKA_SSL: zBool(false),
    KAFKA_SASL_MECHANISM: zEnum(KAFKA_SASL_MECHANISMS),
    KAFKA_SASL_USERNAME: zStr(),
    KAFKA_SASL_PASSWORD: zStr(),
    KAFKA_CONNECTION_TIMEOUT_MS: zInt(3000, { min: 1 }),
    KAFKA_REQUEST_TIMEOUT_MS: zInt(30_000, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    if (env.KAFKA_SASL_MECHANISM === undefined) return;
    for (const key of ['KAFKA_SASL_USERNAME', 'KAFKA_SASL_PASSWORD'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when KAFKA_SASL_MECHANISM is set`,
        });
      }
    }
  })
  .transform((env) => ({
    brokers: env.KAFKA_BROKERS,
    clientId: env.KAFKA_CLIENT_ID ?? env.SERVICE_NAME,
    /** Stable group id (transport sets `postfixId: ''` so Nest doesn't append `-server`). */
    groupId: env.KAFKA_GROUP_ID ?? env.SERVICE_NAME,
    partitionsConsumedConcurrently: env.KAFKA_CONSUMER_CONCURRENCY,
    ssl: env.KAFKA_SSL,
    sasl:
      env.KAFKA_SASL_MECHANISM !== undefined &&
      env.KAFKA_SASL_USERNAME !== undefined &&
      env.KAFKA_SASL_PASSWORD !== undefined
        ? {
            mechanism: env.KAFKA_SASL_MECHANISM,
            username: env.KAFKA_SASL_USERNAME,
            password: env.KAFKA_SASL_PASSWORD,
          }
        : undefined,
    connectionTimeoutMs: env.KAFKA_CONNECTION_TIMEOUT_MS,
    requestTimeoutMs: env.KAFKA_REQUEST_TIMEOUT_MS,
  }));

/** Kafka (kafkajs) brokers, client/group ids, security and consumer concurrency. */
export const kafkaConfig = defineConfigNamespace('kafka', kafkaEnvSchema);
export type KafkaConfig = ConfigType<typeof kafkaConfig>;
