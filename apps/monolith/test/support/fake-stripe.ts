import Stripe from 'stripe';

/** A balance transaction the fake Stripe holds: the fields the ledger reads. */
export interface FakeBalanceTransaction {
  readonly id: string;
  readonly amount: number;
  readonly fee: number;
  readonly currency: string;
  /** Unix seconds. */
  readonly created: number;
  readonly reportingCategory: 'charge' | 'payout';
  /** The charge or payout the transaction belongs to. */
  readonly source: { readonly id: string; readonly amount?: number; readonly currency?: string };
}

/**
 * Stripe for the ledger e2e: the SDK client with the four resources the ledger GETs replaced
 * (`charges`, `payouts`, `balanceTransactions.retrieve` and `.list`), everything else the real SDK
 * (`webhooks.constructEvent` verifies real signatures). Nothing leaves the process: the real client
 * is built with a test key and its network methods are never called.
 */
export class FakeStripe {
  readonly client: Stripe;
  readonly transactions: FakeBalanceTransaction[] = [];
  /** Every Stripe GET made, as `resource:id` (`balanceTransactions:list` for a listing). */
  readonly requests: string[] = [];

  constructor() {
    const real = new Stripe('sk_test_fake_stripe_e2e');
    this.client = new Proxy(real, {
      get: (target, property, receiver): unknown => {
        switch (property) {
          case 'charges':
            return { retrieve: (id: string) => this.retrieveSource('charges', id) };
          case 'payouts':
            return { retrieve: (id: string) => this.retrieveSource('payouts', id) };
          case 'balanceTransactions':
            return {
              retrieve: async (id: string) => this.retrieveTransaction(id),
              list: (params: { created: { gte: number; lt: number } }) => this.list(params),
            };
          default:
            return Reflect.get(target, property, receiver) as unknown;
        }
      },
    });
  }

  /** Registers a balance transaction: its charge or payout becomes retrievable. */
  add(transaction: FakeBalanceTransaction): FakeBalanceTransaction {
    this.transactions.push(transaction);
    return transaction;
  }

  private toStripe(transaction: FakeBalanceTransaction, expandSource: boolean) {
    return {
      id: transaction.id,
      object: 'balance_transaction',
      amount: transaction.amount,
      fee: transaction.fee,
      net: transaction.amount - transaction.fee,
      currency: transaction.currency,
      created: transaction.created,
      reporting_category: transaction.reportingCategory,
      type: transaction.reportingCategory,
      source: expandSource ? this.sourceObject(transaction) : transaction.source.id,
    } as unknown as Stripe.BalanceTransaction;
  }

  private sourceObject(transaction: FakeBalanceTransaction) {
    const { source, reportingCategory } = transaction;
    return {
      id: source.id,
      object: reportingCategory === 'charge' ? 'charge' : 'payout',
      amount: source.amount ?? Math.abs(transaction.amount),
      currency: source.currency ?? transaction.currency,
      metadata: {},
    };
  }

  private async retrieveSource(resource: 'charges' | 'payouts', id: string) {
    this.requests.push(`${resource}:${id}`);
    const transaction = this.transactions.find((candidate) => candidate.source.id === id);
    if (transaction === undefined) throw new Error(`fake Stripe: no ${resource} ${id}`);
    return {
      ...this.sourceObject(transaction),
      balance_transaction: this.toStripe(transaction, false),
      failure_balance_transaction: null,
    };
  }

  private async retrieveTransaction(id: string): Promise<Stripe.BalanceTransaction> {
    this.requests.push(`balanceTransactions:${id}`);
    const transaction = this.transactions.find((candidate) => candidate.id === id);
    if (transaction === undefined) throw new Error(`fake Stripe: no balance transaction ${id}`);
    return this.toStripe(transaction, false);
  }

  private async *list(params: {
    created: { gte: number; lt: number };
  }): AsyncGenerator<Stripe.BalanceTransaction> {
    this.requests.push('balanceTransactions:list');
    for (const transaction of this.transactions) {
      if (transaction.created < params.created.gte || transaction.created >= params.created.lt) {
        continue;
      }
      yield this.toStripe(transaction, true);
    }
  }
}
