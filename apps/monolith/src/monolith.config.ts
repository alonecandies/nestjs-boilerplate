import { defineConfigNamespace, zStr } from '@app/config';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { MONOLITH_KAFKA_GROUP_ID } from './app.constants.js';

/**
 * Monolith-only settings, validated with the same machinery as the shared `@app/config`
 * namespaces (errors name the variable).
 *
 * `KAFKA_GROUP_ID` is also read by the shared `kafka` namespace, whose default is `SERVICE_NAME`;
 * the consumer group of THIS app must not depend on how the service happens to be named, so its
 * default is the blueprint's fixed group (`monolith`) instead.
 */
export const monolithEnvSchema = z
  .object({
    KAFKA_GROUP_ID: zStr(MONOLITH_KAFKA_GROUP_ID, {
      pattern: /^[A-Za-z0-9._-]{1,249}$/,
      patternMessage: 'Expected a Kafka group id: [A-Za-z0-9._-], max 249 chars',
    }),
  })
  .transform((env) => ({
    /** Consumer group of the hybrid Kafka server (`connectKafkaConsumer`). */
    kafkaGroupId: env.KAFKA_GROUP_ID,
  }));

export const monolithConfig = defineConfigNamespace('monolith', monolithEnvSchema);
export type MonolithConfig = ConfigType<typeof monolithConfig>;
