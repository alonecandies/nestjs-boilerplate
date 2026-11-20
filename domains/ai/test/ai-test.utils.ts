import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import type { InMemoryAiStore } from '../src/testing/in-memory-ai.js';

export interface TestTransactions {
  begun: number;
  rolledBack: number;
  /** `true` while a `@Transactional()` method runs. */
  active: boolean;
}

/** A copy of the store's rows (the Map and arrays are new; records are immutable). */
function snapshot(store: InMemoryAiStore) {
  return {
    conversations: new Map(store.conversations),
    messages: [...store.messages],
    usage: [...store.usage],
  };
}

/**
 * Registers a `TransactionHost` (the default instance `@Transactional()` uses) whose transactions
 * restore `store` on a rollback, so handler specs see the unit-of-work boundaries of the real
 * adapter: a method that throws leaves nothing of its writes behind.
 */
export function installTestTransactionHost(store: InMemoryAiStore): TestTransactions {
  const tx: TestTransactions = { begun: 0, rolledBack: 0, active: false };
  const instance = { transaction: true };
  new TransactionHost<DrizzleTransactionalAdapter>({
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
    extraProviderTokens: [],
    getFallbackInstance: () => instance as never,
    wrapWithTransaction: async (_options, fn, setTx) => {
      const before = snapshot(store);
      tx.begun += 1;
      tx.active = true;
      setTx(instance as never);
      try {
        return await fn();
      } catch (error) {
        tx.rolledBack += 1;
        store.conversations.clear();
        for (const [key, value] of before.conversations) store.conversations.set(key, value);
        store.messages.splice(0, store.messages.length, ...before.messages);
        store.usage.splice(0, store.usage.length, ...before.usage);
        throw error;
      } finally {
        tx.active = false;
      }
    },
  });
  return tx;
}
