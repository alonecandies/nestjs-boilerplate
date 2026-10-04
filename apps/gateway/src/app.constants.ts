import type { ApiDocsOptions } from '@app/bootstrap';

/**
 * `service.name` of the traces when neither `OTEL_SERVICE_NAME` nor `SERVICE_NAME` is set.
 * Kept free of runtime imports: `instrument.ts` loads it before anything else is imported.
 */
export const GATEWAY_SERVICE_NAME = 'gateway';

/**
 * Default consumer group of the push consumer (`notifications.notification-created.v1` →
 * Socket.IO room `user:{id}` + GraphQL subscription). ALL gateway replicas share it: each event is
 * consumed once, and the Redis Socket.IO adapter / Redis PubSub fan it out to the replica that
 * holds the user's connection. It must differ from notifications-service's group, which consumes
 * other topics for other reasons. Override with `KAFKA_GROUP_ID` (see `gateway.config.ts`).
 */
export const GATEWAY_KAFKA_GROUP_ID = 'gateway-push';

/** OpenAPI document + Scalar reference (`/openapi.json`, `/openapi.yaml`, `/docs`). */
export const GATEWAY_API_DOCS: ApiDocsOptions = {
  title: 'NestJS Boilerplate API',
  description:
    'API gateway of the microservices topology: REST under `/v1`, GraphQL at `/graphql` and the ' +
    'Socket.IO namespace `/notifications`, served here and executed by identity-, ' +
    'notifications- and billing-service over gRPC. Access tokens are verified at the edge. ' +
    'Errors are RFC 9457 `application/problem+json`.',
  version: '1.0.0',
};
