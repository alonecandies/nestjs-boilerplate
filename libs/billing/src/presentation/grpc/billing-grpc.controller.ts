import {
  type BillingServiceController,
  BillingServiceControllerMethods,
  type CheckoutSession,
  type CreateCheckoutSessionRequest,
  type HandleStripeWebhookRequest,
  type HandleStripeWebhookResponse,
  type ListPaymentsRequest,
  type PaymentList,
} from '@app/contracts';
import { GrpcController, ZodRpcValidationPipe } from '@app/transport';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import { CreateCheckoutSessionCommand } from '../../application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../../application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { ListPaymentsQuery } from '../../application/queries/list-payments/list-payments.query.js';
import {
  createCheckoutSessionRpcSchema,
  handleStripeWebhookRpcSchema,
  listPaymentsRpcSchema,
} from './billing-grpc.schemas.js';

/**
 * `billing.v1.BillingService` (billing-service). Payloads are zod-validated (`INVALID_ARGUMENT`
 * with issues on failure) and mapped 1:1 onto the CQRS buses; `@GrpcController()` maps
 * DomainExceptions to gRPC statuses + `x-error-code` trailers. Authorization is the caller's job:
 * only the gateway (which enforces RBAC) can reach this port.
 */
@GrpcController()
@BillingServiceControllerMethods()
export class BillingGrpcController implements BillingServiceController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  createCheckoutSession(
    @Payload(new ZodRpcValidationPipe(createCheckoutSessionRpcSchema))
    request: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    return this.commandBus.execute(new CreateCheckoutSessionCommand(request));
  }

  handleStripeWebhook(
    @Payload(new ZodRpcValidationPipe(handleStripeWebhookRpcSchema))
    request: HandleStripeWebhookRequest,
  ): Promise<HandleStripeWebhookResponse> {
    return this.commandBus.execute(
      new HandleStripeWebhookCommand(request.payload, request.signature),
    );
  }

  listPayments(
    @Payload(new ZodRpcValidationPipe(listPaymentsRpcSchema)) request: ListPaymentsRequest,
  ): Promise<PaymentList> {
    return this.queryBus.execute(
      new ListPaymentsQuery({ userId: request.userId, limit: request.limit }),
    );
  }
}
