import type { ClientInfo } from '@app/contracts';
import { isString } from 'lodash-es';
import { IDENTITY_LIMITS } from '../../identity.constants.js';

/** Client fingerprint as stored on a session. */
export interface SessionClient {
  userAgent: string | null;
  ip: string | null;
}

const bounded = (value: unknown, max: number): string | null => {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
};

/**
 * Normalises the client fingerprint (audit / theft investigation). Values are attacker-controlled
 * headers: bounded before they reach the database. Tolerates gRPC `null`s.
 */
export function toSessionClient(client: ClientInfo | null | undefined): SessionClient {
  return {
    userAgent: bounded(client?.userAgent, IDENTITY_LIMITS.USER_AGENT_MAX_LENGTH),
    ip: bounded(client?.ip, IDENTITY_LIMITS.IP_MAX_LENGTH),
  };
}
