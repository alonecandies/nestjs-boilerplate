import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type CreateHttpAppOptions, createHttpApp } from './create-http-app.js';

/**
 * HTTP side of a gRPC/Kafka service: the port only serves `/health/*` and `/metrics` (infra
 * contract: every process exposes them), so no raw body, multipart, CORS or cookies. Connect the
 * transports afterwards (`connectGrpcServer` / `connectKafkaConsumer` from `@app/transport`), then
 * `app.startAllMicroservices()` and `listen(app)`.
 */
export function createServiceApp(
  module: Type<unknown>,
  options: Omit<CreateHttpAppOptions, 'rawBody' | 'multipart'> = {},
): Promise<NestFastifyApplication> {
  return createHttpApp(module, {
    cors: false,
    cookies: false,
    ...options,
    rawBody: false,
    multipart: false,
  });
}
