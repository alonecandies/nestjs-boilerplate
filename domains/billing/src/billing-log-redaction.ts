import { STRIPE_SIGNATURE_HEADER } from './billing.constants.js';

/**
 * Log paths the billing context needs masked, passed by the apps that serve its HTTP edge (the
 * Stripe webhook): `ObservabilityModule.forRoot({ redactPaths: BILLING_LOG_REDACT_PATHS })`. The
 * request serializers drop headers already; this keeps the signature masked if one ever logs them.
 * The path is built from `STRIPE_SIGNATURE_HEADER`, the header name the webhook route reads.
 */
export const BILLING_LOG_REDACT_PATHS: readonly string[] = [
  `req.headers["${STRIPE_SIGNATURE_HEADER}"]`,
];
