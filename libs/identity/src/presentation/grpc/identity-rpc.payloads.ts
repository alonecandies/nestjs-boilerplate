import { MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT } from '@app/common';
import type {
  ClientInfo,
  GetUserRequest,
  GetUsersByIdsRequest,
  ListUsersRequest,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  UpdateUserRolesRequest,
} from '@app/contracts';
import { z } from 'zod';
import { IDENTITY_LIMITS } from '../../identity.constants.js';

/*
 * zod schemas for gRPC payloads (class-validator cannot see ts-proto interfaces: their
 * metatype is `Object`). Same limits as the REST DTOs / GraphQL inputs. proto-loader decodes an
 * absent message as `null` and an absent proto3 `optional` scalar as a missing key: both become
 * `undefined` here, so handlers never see `null`. `satisfies` pins each output to the contract.
 */

const optionalString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value === null || value === '' ? undefined : value));

const clientInfo = z
  .object({
    // Attacker-controlled headers: bounded here, truncated again before storage.
    userAgent: optionalString(2_048),
    ip: optionalString(256),
  })
  .nullish()
  .transform((value): ClientInfo | undefined => value ?? undefined);

const password = z.string().min(1).max(IDENTITY_LIMITS.PASSWORD_MAX_LENGTH);
const refreshToken = z.string().min(1).max(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH);

export const registerRequestSchema = z.object({
  email: z.string().trim().max(IDENTITY_LIMITS.EMAIL_MAX_LENGTH).pipe(z.email()),
  password: password.min(IDENTITY_LIMITS.PASSWORD_MIN_LENGTH),
  displayName: z
    .string()
    .trim()
    .min(IDENTITY_LIMITS.DISPLAY_NAME_MIN_LENGTH)
    .max(IDENTITY_LIMITS.DISPLAY_NAME_MAX_LENGTH),
  client: clientInfo,
}) satisfies z.ZodType<RegisterRequest>;

export const loginRequestSchema = z.object({
  email: z.string().min(1).max(IDENTITY_LIMITS.EMAIL_MAX_LENGTH),
  password,
  client: clientInfo,
}) satisfies z.ZodType<LoginRequest>;

export const refreshTokensRequestSchema = z.object({
  refreshToken,
  client: clientInfo,
}) satisfies z.ZodType<RefreshTokensRequest>;

export const logoutRequestSchema = z.object({
  userId: z.uuid(),
  accessTokenJti: z.string().min(1).max(128),
  /** int64 epoch seconds (a string with `longs: String`). */
  accessTokenExp: z.string().regex(/^\d{1,12}$/, 'Expected epoch seconds'),
  refreshToken: optionalString(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH),
}) satisfies z.ZodType<LogoutRequest>;

export const getUserRequestSchema = z.object({
  id: z.uuid(),
}) satisfies z.ZodType<GetUserRequest>;

export const getUsersByIdsRequestSchema = z.object({
  // Non-uuid ids are dropped by the handler (like unknown ids); only the batch size is bounded.
  ids: z.array(z.string().max(64)).max(IDENTITY_LIMITS.USERS_BATCH_MAX),
}) satisfies z.ZodType<GetUsersByIdsRequest>;

export const listUsersRequestSchema = z.object({
  /** 0 = unset (proto3 default) → default page size. */
  limit: z.number().int().min(0).max(MAX_PAGE_LIMIT),
  cursor: optionalString(MAX_CURSOR_LENGTH),
  search: optionalString(IDENTITY_LIMITS.SEARCH_MAX_LENGTH),
}) satisfies z.ZodType<ListUsersRequest>;

export const updateUserRolesRequestSchema = z.object({
  id: z.uuid(),
  // Role names are validated by the aggregate (one error model for every transport).
  roles: z.array(z.string().max(32)).max(10),
  actorId: z.uuid(),
}) satisfies z.ZodType<UpdateUserRolesRequest>;
