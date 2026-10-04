import { defineConfigNamespace, zStr } from '@app/config';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { GATEWAY_KAFKA_GROUP_ID } from './app.constants.js';

/**
 * Gateway-only settings, validated with the same machinery as the shared `@app/config`
 * namespaces (errors name the variable).
 *
 * `KAFKA_GROUP_ID` is also read by the shared `kafka` namespace, whose default is `SERVICE_NAME`;
 * the push consumer's group must not depend on how the service happens to be named, so its
 * default is the blueprint's fixed group (`gateway-push`) instead.
 */
export const gatewayEnvSchema = z
  .object({
    KAFKA_GROUP_ID: zStr(GATEWAY_KAFKA_GROUP_ID, {
      pattern: /^[A-Za-z0-9._-]{1,249}$/,
      patternMessage: 'Expected a Kafka group id: [A-Za-z0-9._-], max 249 chars',
    }),
  })
  .transform((env) => ({
    /** Consumer group of the hybrid Kafka server (`connectKafkaConsumer`). */
    kafkaGroupId: env.KAFKA_GROUP_ID,
  }));

export const gatewayConfig = defineConfigNamespace('gateway', gatewayEnvSchema);
export type GatewayConfig = ConfigType<typeof gatewayConfig>;
