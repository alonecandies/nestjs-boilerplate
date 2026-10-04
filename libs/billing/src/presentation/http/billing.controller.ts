import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@app/auth';
import { HTTP_HEADERS, Public } from '@app/common';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  RawBody,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { BillingPort } from '../../application/ports/billing.port.js';
import { BILLING_LIMITS } from '../../billing.constants.js';
import { resolvePaymentsOwner } from '../payments-scope.js';
import {
  type CheckoutSessionResponse,
  checkoutSessionResponseSchema,
  type PaymentListResponse,
  paymentListResponseSchema,
  type StripeWebhookResponse,
  stripeWebhookResponseSchema,
  toPaymentListResponse,
} from './dto/billing.response.js';
import {
  type CreateCheckoutSessionBody,
  createCheckoutSessionBodySchema,
} from './dto/create-checkout-session.dto.js';
import {
  type ListPaymentsQueryDto,
  listPaymentsQuerySchema,
} from './dto/list-payments-query.dto.js';
import { HeaderValue, IdempotencyKey } from './request-headers.decorator.js';

/**
 * `/v1/billing` — identical in the monolith and the gateway: it only talks to `BillingPort`.
 * Responses are shaped by the `to*Response` mappers and enforced by the Standard Schema
 * serializer (HTTP-only controller, so a controller-scoped interceptor is safe).
 */
@ApiTags('billing')
@Controller({ path: 'billing', version: '1' })
@UseInterceptors(StandardSchemaSerializerInterceptor)
export class BillingController {
  constructor(private readonly billing: BillingPort) {}

  @Post('checkout-sessions')
  @RequirePermissions(Permission.BillingCheckout)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start a Stripe Checkout',
    description:
      'Creates a hosted Stripe Checkout Session for `quantity × priceId` and a `pending` payment. ' +
      'Send an `Idempotency-Key` to make retries return the same session.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: `Replays with the same key return the same session (${BILLING_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH}-${BILLING_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH} chars of [A-Za-z0-9._:-]).`,
  })
  @ApiCreatedResponse({ standardSchema: checkoutSessionResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid body or Idempotency-Key' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Requires billing:checkout' })
  @ApiConflictResponse({ description: 'Idempotency-Key reused for a different request' })
  @SerializeOptions({ schema: checkoutSessionResponseSchema })
  createCheckoutSession(
    @Body({ schema: createCheckoutSessionBodySchema }) body: CreateCheckoutSessionBody,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<CheckoutSessionResponse> {
    return this.billing.createCheckoutSession({
      userId: user.id,
      customerEmail: user.email,
      priceId: body.priceId,
      quantity: body.quantity,
      idempotencyKey,
    });
  }

  @Post('webhooks/stripe')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stripe webhook',
    description:
      'Called by Stripe. The `Stripe-Signature` header is verified over the raw request body; ' +
      'each event id is applied once (duplicates are acknowledged with `duplicate: true`).',
  })
  @ApiHeader({ name: 'Stripe-Signature', required: true })
  @ApiBody({ description: 'Stripe Event (JSON)', schema: { type: 'object' } })
  @ApiOkResponse({ standardSchema: stripeWebhookResponseSchema })
  @ApiUnprocessableEntityResponse({ description: 'Missing, forged or stale signature' })
  @SerializeOptions({ schema: stripeWebhookResponseSchema })
  handleStripeWebhook(
    @RawBody() rawBody: Buffer | undefined,
    @HeaderValue(HTTP_HEADERS.STRIPE_SIGNATURE) signature: string | undefined,
  ): Promise<StripeWebhookResponse> {
    // Needs the app created with `rawBody: true` (createHttpApp({ rawBody: true })): the signature
    // covers the exact bytes, re-serialised JSON never verifies.
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new BadRequestException('The raw request body is required');
    }
    return this.billing.handleStripeWebhook({ payload: rawBody, signature: signature ?? '' });
  }

  @Get('payments')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List payments',
    description:
      "Newest first, keyset-paginated (`cursor` = the previous page's `nextCursor`). `all=true` lists every user's payments (requires billing:read-all).",
  })
  @ApiOkResponse({ standardSchema: paymentListResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid query' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: '`all=true` without billing:read-all' })
  @ApiUnprocessableEntityResponse({ description: 'Malformed `cursor` (INVALID_CURSOR)' })
  @SerializeOptions({ schema: paymentListResponseSchema })
  async listPayments(
    @Query({ schema: listPaymentsQuerySchema }) query: ListPaymentsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentListResponse> {
    const list = await this.billing.listPayments({
      userId: resolvePaymentsOwner(user, query.all),
      limit: query.limit,
      cursor: query.cursor,
    });
    return toPaymentListResponse(list);
  }
}
