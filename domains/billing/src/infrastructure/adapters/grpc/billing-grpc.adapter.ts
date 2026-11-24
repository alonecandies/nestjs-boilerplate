import {
  BILLING_GRPC_PACKAGE,
  BILLING_SERVICE_NAME,
  type BillingServiceClient,
  type CheckoutSession,
  type CreateCheckoutSessionRequest,
  type HandleStripeWebhookRequest,
  type HandleStripeWebhookResponse,
  type ListPaymentsRequest,
  type Payment,
  type PaymentList,
} from '@domain/billing-contracts';
import type { Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import {
  callerContextFromCls,
  createOutgoingMetadata,
  GrpcCircuitBreakers,
  grpcCall,
  type RpcCallerContext,
} from '@platform/transport';
import { isNil } from 'lodash-es';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';
import type { BillingPort } from '../../../application/ports/billing.port.js';
import { BILLING_GRPC_STRIPE_UPSTREAM, BILLING_GRPC_UPSTREAM } from '../../../billing.constants.js';
import {
  type BillingGrpcClientConfig,
  billingGrpcClientConfig,
} from './billing-grpc-client.config.js';

/** A `Date`, or `undefined` for the `null` proto-loader (`defaults: true`) sends for absent messages. */
const optionalDate = (value: Date | null | undefined): Date | undefined =>
  value instanceof Date ? value : undefined;

/** proto-loader decodes absent optional fields as `null`; the port contract says `undefined`. */
export function normalizePayment(payment: Payment): Payment {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    userId: payment.userId,
    status: payment.status,
    amountTotal: payment.amountTotal || '0',
    currency: payment.currency,
    priceId: payment.priceId,
    quantity: payment.quantity,
    ...(payment.stripeCheckoutSessionId == null
      ? {}
      : { stripeCheckoutSessionId: payment.stripeCheckoutSessionId }),
    createdAt: optionalDate(payment.createdAt),
    updatedAt: optionalDate(payment.updatedAt),
  };
}

/** How a call is bounded: its local deadline and the breaker it counts against. */
interface CallBudget {
  timeoutMs: number;
  upstream: string;
}

/**
 * `BillingPort` over gRPC (gateway → billing-service): per-call deadline and circuit breaker,
 * request/correlation id + caller propagation in metadata, and upstream failures mapped back to the
 * same `DomainException`s the local adapter throws (`grpcCall`).
 *
 * The calls that wait on Stripe (`CreateCheckoutSession`, `HandleStripeWebhook`) get
 * `BILLING_GRPC_STRIPE_DEADLINE_MS` and the `billing-stripe` breaker; `ListPayments` keeps
 * `GRPC_DEADLINE_MS` and the `billing` breaker. Slow Stripe calls thus neither time out at the
 * generic deadline nor cut off payment listing. A Stripe deadline below `GRPC_DEADLINE_MS` works but
 * is almost certainly a mistake, so it is reported once at module init (a warning, not a refusal).
 */
@Injectable()
export class BillingGrpcAdapter implements BillingPort, OnModuleInit {
  private readonly logger = new Logger(BillingGrpcAdapter.name);
  private client: BillingServiceClient;

  constructor(
    @Inject(BILLING_GRPC_PACKAGE.clientToken) private readonly grpc: ClientGrpc,
    @Inject(grpcConfig.KEY) private readonly config: GrpcConfig,
    @Inject(billingGrpcClientConfig.KEY) private readonly billing: BillingGrpcClientConfig,
    private readonly breakers: GrpcCircuitBreakers,
    @Optional() private readonly cls?: ClsService,
  ) {}

  onModuleInit(): void {
    this.client = this.grpc.getService<BillingServiceClient>(BILLING_SERVICE_NAME);
    if (this.billing.stripeDeadlineMs < this.config.deadlineMs) {
      this.logger.warn(
        `BILLING_GRPC_STRIPE_DEADLINE_MS (${this.billing.stripeDeadlineMs}) is below ` +
          `GRPC_DEADLINE_MS (${this.config.deadlineMs}): the calls that wait on Stripe ` +
          '(CreateCheckoutSession, HandleStripeWebhook) get less time than every other call',
      );
    }
  }

  createCheckoutSession(input: CreateCheckoutSessionRequest): Promise<CheckoutSession> {
    return this.call(
      'CreateCheckoutSession',
      { userId: input.userId },
      (md) => this.client.createCheckoutSession(input, md),
      this.stripeBudget(),
    );
  }

  handleStripeWebhook(input: HandleStripeWebhookRequest): Promise<HandleStripeWebhookResponse> {
    // `bytes` on the wire: the raw body travels untouched, the service verifies the signature.
    return this.call(
      'HandleStripeWebhook',
      {},
      (md) =>
        this.client.handleStripeWebhook({ payload: input.payload, signature: input.signature }, md),
      this.stripeBudget(),
    );
  }

  async listPayments(input: ListPaymentsRequest): Promise<PaymentList> {
    const list = await this.call('ListPayments', {}, (md) => this.client.listPayments(input, md));
    // Repeated fields decode as [] with `defaults: true`; `?? []` also covers a hand-written server.
    // An absent `next_cursor` decodes as null (or ""): the port contract omits it.
    return {
      items: (list.items ?? []).map(normalizePayment),
      ...(isNil(list.nextCursor) || list.nextCursor === '' ? {} : { nextCursor: list.nextCursor }),
    };
  }

  private stripeBudget(): CallBudget {
    return { timeoutMs: this.billing.stripeDeadlineMs, upstream: BILLING_GRPC_STRIPE_UPSTREAM };
  }

  private call<T>(
    method: string,
    caller: RpcCallerContext,
    invoke: (metadata: Metadata) => Observable<T>,
    budget: CallBudget = { timeoutMs: this.config.deadlineMs, upstream: BILLING_GRPC_UPSTREAM },
  ): Promise<T> {
    const metadata = createOutgoingMetadata(callerContextFromCls(this.cls, caller));
    return grpcCall(invoke(metadata), {
      timeoutMs: budget.timeoutMs,
      operation: `${BILLING_GRPC_PACKAGE.package}.${BILLING_SERVICE_NAME}/${method}`,
      breaker: this.breakers.get(budget.upstream),
    });
  }
}
