import { createMock, type Mocked } from '@app/testing';

/**
 * `createMock<T>()` typed as `Mocked<T> & T`: classes with private members (TokenService,
 * CommandBus…) are then accepted by constructors while every method keeps its vi.fn() API.
 */
export function mockOf<T extends object>(
  overrides?: Partial<Record<keyof T, unknown>>,
): Mocked<T> & T {
  return createMock<T>(overrides) as Mocked<T> & T;
}
