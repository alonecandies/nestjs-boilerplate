import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLUUID } from '@platform/graphql';

@ObjectType('CheckoutSession', { description: 'A hosted Stripe Checkout Session' })
export class CheckoutSessionModel {
  @Field(() => ID, { description: 'Stripe Checkout Session id (cs_…)' })
  id: string;

  @Field({ description: 'Hosted Checkout page to redirect the customer to' })
  url: string;

  @Field(() => GraphQLUUID)
  paymentId: string;
}
