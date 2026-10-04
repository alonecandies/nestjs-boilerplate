import type { ApiDocsOptions } from '@app/bootstrap';

/**
 * `service.name` of the traces when neither `OTEL_SERVICE_NAME` nor `SERVICE_NAME` is set.
 * Kept free of runtime imports: `instrument.ts` loads it before anything else is imported.
 */
export const MONOLITH_SERVICE_NAME = 'monolith';

/**
 * Default consumer group of the in-process Kafka consumers (identity/billing integration events →
 * notifications, and the WebSocket/GraphQL push). Every monolith replica must share it so each
 * event is handled once. Override with `KAFKA_GROUP_ID` (see `monolith.config.ts`).
 */
export const MONOLITH_KAFKA_GROUP_ID = 'monolith';

/** OpenAPI document + Scalar reference (`/openapi.json`, `/openapi.yaml`, `/docs`). */
export const MONOLITH_API_DOCS: ApiDocsOptions = {
  title: 'NestJS Boilerplate API',
  description:
    'Modular monolith: identity (auth + users), notifications, billing (Stripe) and files in one ' +
    'process. REST under `/v1`, GraphQL at `/graphql`, Socket.IO namespace `/notifications`. ' +
    'Errors are RFC 9457 `application/problem+json`.',
  version: '1.0.0',
};
