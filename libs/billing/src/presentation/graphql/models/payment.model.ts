import type { Payment, PaymentList } from '@app/contracts';
import { GraphQLUUID } from '@app/graphql';
import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { toUpper, zipObject } from 'lodash-es';
import { PAYMENT_STATUSES, type PaymentStatus } from '../../../domain/payment-status.enum.js';

/**
 * GraphQL `PaymentStatus`: SCREAMING_CASE names (GraphQL convention) whose internal values are the
 * domain statuses — `SUCCEEDED` ↔ `'succeeded'`.
 */
export const PaymentStatusGraphqlEnum: Readonly<Record<string, PaymentStatus>> = zipObject(
  PAYMENT_STATUSES.map(toUpper),
  PAYMENT_STATUSES,
);

registerEnumType(PaymentStatusGraphqlEnum, {
  name: 'PaymentStatus',
  description: 'Lifecycle of a Stripe Checkout payment',
});

@ObjectType('Payment', { description: 'A Stripe Checkout payment' })
export class PaymentModel {
  @Field(() => ID)
  id: string;

  /** Parent key of the batched `user` field (DataLoader). */
  @Field(() => GraphQLUUID)
  userId: string;

  @Field(() => PaymentStatusGraphqlEnum)
  status: PaymentStatus;

  // Float, not Int: GraphQL Int is 32-bit, minor-unit totals of some currencies exceed it.
  @Field(() => Float, { description: 'Minor currency units (an integer, e.g. cents)' })
  amountTotal: number;

  @Field({ description: 'ISO 4217, lowercase; empty until Stripe priced the session' })
  currency: string;

  @Field()
  priceId: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => String, { nullable: true })
  stripeCheckoutSessionId: string | null;

  @Field(() => Date, { nullable: true })
  createdAt: Date | null;

  @Field(() => Date, { nullable: true })
  updatedAt: Date | null;
}

@ObjectType('PaymentConnection', { description: 'One page of payments, newest first.' })
export class PaymentConnectionModel {
  @Field(() => [PaymentModel])
  items: PaymentModel[];

  @Field(() => String, {
    nullable: true,
    description: 'Pass as `cursor` to get the next page; null on the last page.',
  })
  nextCursor: string | null;
}

export function toPaymentConnectionModel(list: PaymentList): PaymentConnectionModel {
  return Object.assign(new PaymentConnectionModel(), {
    items: list.items.map(toPaymentModel),
    nextCursor: list.nextCursor ?? null,
  });
}

export function toPaymentModel(payment: Payment): PaymentModel {
  return Object.assign(new PaymentModel(), {
    id: payment.id,
    userId: payment.userId,
    status: payment.status as PaymentStatus,
    amountTotal: Number(payment.amountTotal),
    currency: payment.currency,
    priceId: payment.priceId,
    quantity: payment.quantity,
    stripeCheckoutSessionId: payment.stripeCheckoutSessionId ?? null,
    createdAt: payment.createdAt ?? null,
    updatedAt: payment.updatedAt ?? null,
  });
}
