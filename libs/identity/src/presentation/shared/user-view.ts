import { isRole, type Role } from '@app/auth';
import { isUuidV7, uuidV7Timestamp } from '@app/common';
import type { User } from '@app/contracts';
import { isDate, isNumber, isString } from 'lodash-es';

/** The user as every presentation (REST response, GraphQL model) renders it. */
export interface UserView {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  createdAt: Date;
  updatedAt: Date;
}

/** Accepts a Date, or the ISO string a JSON cache tier (Redis L2) turns it into. */
function toDate(value: unknown): Date | undefined {
  const date = isDate(value) ? value : isString(value) || isNumber(value) ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/**
 * Contract `User` → view. Timestamps are optional on the wire (proto message fields); a uuidv7 id
 * carries its creation time, which is the exact fallback for `createdAt`.
 */
export function toUserView(user: User): UserView {
  const createdAt =
    toDate(user.createdAt) ?? (isUuidV7(user.id) ? uuidV7Timestamp(user.id) : new Date(0));
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles.filter(isRole),
    createdAt,
    updatedAt: toDate(user.updatedAt) ?? createdAt,
  };
}

/** Revives a user read back from a JSON cache tier (dates as strings). */
export function reviveUser(user: User): User {
  return {
    ...user,
    createdAt: toDate(user.createdAt),
    updatedAt: toDate(user.updatedAt),
  };
}
