import { generateId } from '@app/common';
import type { AuthTokens, User } from '@app/contracts';
import type { UserRecord } from '../src/application/persistence/users.repository.js';
import type { UserSnapshot } from '../src/domain/user.aggregate.js';

export const NOW = new Date('2026-09-29T12:00:00.000Z');

export function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: generateId(),
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    roles: ['user'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeUserSnapshot(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    ...makeUserRecord(),
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    ...overrides,
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: generateId(),
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    roles: ['user'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeAuthTokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    accessToken: 'access.jwt.token',
    refreshToken: 'refresh.jwt.token',
    expiresIn: 900,
    tokenType: 'Bearer',
    user: makeUser(),
    ...overrides,
  };
}

/** A pass-through `TransactionRunner` that records how often a transaction was opened. */
export function passThroughTransaction(): {
  run: <T>(work: () => Promise<T>) => Promise<T>;
  runs: number;
} {
  const runner = {
    runs: 0,
    run: <T>(work: () => Promise<T>): Promise<T> => {
      runner.runs += 1;
      return work();
    },
  };
  return runner;
}
