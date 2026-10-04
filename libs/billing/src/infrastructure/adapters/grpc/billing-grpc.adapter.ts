import { type GrpcConfig, grpcConfig } from '@app/config';
import {
  BILLING_SERVICE_NAME,
  type BillingServiceClient,
  type CheckoutSession,
  type CreateCheckoutSessionRequest,
  GRPC_PACKAGES,
  type HandleStripeWebhookRequest,
  type HandleStripeWebhookResponse,
  type ListPaymentsRequest,
  type Payment,
  type PaymentList,
} from '@app/contracts';
import {
  callerContextFromCls,
  createOutgoingMetadata,
  GrpcCircuitBreakers,
  grpcCall,
  type RpcCallerContext,
} from '@app/transport';
import type { Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';
import type { BillingPort } from '../../../application/ports/billing.port.js';
import { BILLING_GRPC_UPSTREAM } from '../../../billing.constants.js';

/** A `Date`, or `undefined` for the `null` proto-loader (`defaults: true`) sends for absent messages. */
const optionalDate = (value: Date | null | undefined): Date | undefined =>
  value instanceof Date ? value : undefined;

/** proto-loader decodes absent optional fields as `null`; the port contract says `undefined`. */
export function normalizePayment(payment: Payment): Payment {
  return {
    id: payment.id,
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

/**
 * `BillingPort` over gRPC (gateway → billing-service): per-call deadline, the `billing` circuit
 * breaker, request/correlation id + caller propagation in metadata, and upstream failures mapped
 * back to the same `DomainException`s the local adapter throws (`grpcCall`).
 */
@Injectable()
export class BillingGrpcAdapter implements BillingPort, OnModuleInit {
  private client: BillingServiceClient;

  constructor(
    @Inject(GRPC_PACKAGES.billing.clientToken) private readonly grpc: ClientGrpc,
    @Inject(grpcConfig.KEY) private readonly config: GrpcConfig,
    private readonly breakers: GrpcCircuitBreakers,
    @Optional() private readonly cls?: ClsService,
  ) {}

  onModuleInit(): void {
    this.client = this.grpc.getService<BillingServiceClient>(BILLING_SERVICE_NAME);
  }

  createCheckoutSession(input: CreateCheckoutSessionRequest): Promise<CheckoutSession> {
    return this.call('CreateCheckoutSession', { userId: input.userId }, (md) =>
      this.client.createCheckoutSession(input, md),
    );
  }

  handleStripeWebhook(input: HandleStripeWebhookRequest): Promise<HandleStripeWebhookResponse> {
    // `bytes` on the wire: the raw body travels untouched, the service verifies the signature.
    return this.call('HandleStripeWebhook', {}, (md) =>
      this.client.handleStripeWebhook({ payload: input.payload, signature: input.signature }, md),
    );
  }

  async listPayments(input: ListPaymentsRequest): Promise<PaymentList> {
    const list = await this.call('ListPayments', {}, (md) => this.client.listPayments(input, md));
    // Repeated fields decode as [] with `defaults: true`; `?? []` also covers a hand-written server.
    return { items: (list.items ?? []).map(normalizePayment) };
  }

  private call<T>(
    method: string,
    caller: RpcCallerContext,
    invoke: (metadata: Metadata) => Observable<T>,
  ): Promise<T> {
    const metadata = createOutgoingMetadata(callerContextFromCls(this.cls, caller));
    return grpcCall(invoke(metadata), {
      timeoutMs: this.config.deadlineMs,
      operation: `billing.BillingService/${method}`,
      breaker: this.breakers.get(BILLING_GRPC_UPSTREAM),
    });
  }
}
