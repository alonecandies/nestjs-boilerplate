import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt } from '../env/env.helpers.js';

export const throttleEnvSchema = z
  .object({
    THROTTLE_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_LIMIT: zInt(300, { min: 1 }),
    THROTTLE_IP_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_IP_LIMIT: zInt(600, { min: 1 }),
    THROTTLE_TENANT_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_TENANT_LIMIT: zInt(3_000, { min: 1 }),
    THROTTLE_GRAPHQL_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_GRAPHQL_COST_LIMIT: zInt(20_000, { min: 1 }),
    THROTTLE_WS_HANDSHAKE_LIMIT: zInt(30, { min: 1 }),
    THROTTLE_WS_HANDSHAKE_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_WS_SOCKETS_PER_USER: zInt(10, { min: 1 }),
    THROTTLE_WS_SOCKET_TTL_MS: zInt(3_600_000, { min: 1_000 }),
    THROTTLE_REDIS_TIMEOUT_MS: zInt(250, { min: 10 }),
  })
  .transform((env) => ({
    /** @nestjs/throttler 6 windows are in MILLISECONDS. Per-user (else per-IP) budget across routes. */
    ttlMs: env.THROTTLE_TTL_MS,
    limit: env.THROTTLE_LIMIT,
    /** Pre-auth flood cap per client IP (all routes), counted before JWT verification. */
    ipTtlMs: env.THROTTLE_IP_TTL_MS,
    ipLimit: env.THROTTLE_IP_LIMIT,
    /** Aggregate budget of the active tenant (spec §11): one noisy tenant can't starve others. */
    tenantTtlMs: env.THROTTLE_TENANT_TTL_MS,
    tenantLimit: env.THROTTLE_TENANT_LIMIT,
    /** GraphQL cost budget per user (else IP): sum of operation complexities per window. */
    graphqlTtlMs: env.THROTTLE_GRAPHQL_TTL_MS,
    graphqlCostLimit: env.THROTTLE_GRAPHQL_COST_LIMIT,
    /** WebSockets (Socket.IO, graphql-ws): handshakes per client IP per window. */
    wsHandshakeLimit: env.THROTTLE_WS_HANDSHAKE_LIMIT,
    wsHandshakeTtlMs: env.THROTTLE_WS_HANDSHAKE_TTL_MS,
    /** Concurrent sockets per user; a slot's TTL (or its token's expiry) bounds a leaked slot. */
    wsSocketsPerUser: env.THROTTLE_WS_SOCKETS_PER_USER,
    wsSocketTtlMs: env.THROTTLE_WS_SOCKET_TTL_MS,
    /** Bound for one throttle command; past it, budgets fail open and auth fails closed. */
    redisTimeoutMs: env.THROTTLE_REDIS_TIMEOUT_MS,
  }));

/** Rate limiting (Redis-backed @nestjs/throttler). Credential limits are domain policies. */
export const throttleConfig = defineConfigNamespace('throttle', throttleEnvSchema);
export type ThrottleConfig = ConfigType<typeof throttleConfig>;
