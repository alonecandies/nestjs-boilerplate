// One-off codemod (B1, Task contracts-3): splits every `@platform/contracts` import of the given
// files between the generic package and the domain contracts packages, by imported name.
//   node contracts-imports-codemod.mjs <file>...
import { readFileSync, writeFileSync } from 'node:fs';

const OWNERS = {
  '@domain/identity-contracts': `identityV1 Empty userRegisteredPayload UserRegisteredPayload
    USER_REGISTERED_EVENT User AuthTokens ClientInfo RegisterRequest LoginRequest
    RefreshTokensRequest LogoutRequest GetUserRequest GetUsersByIdsRequest UserList
    ListUsersRequest UserPage UpdateUserRolesRequest AuthServiceClient AuthServiceController
    AuthServiceControllerMethods AUTH_SERVICE_NAME UsersServiceClient UsersServiceController
    UsersServiceControllerMethods USERS_SERVICE_NAME IDENTITY_GRPC_PACKAGE`,
  '@domain/billing-contracts': `billingV1 BILLING_GRPC_PACKAGE CreateCheckoutSessionRequest
    CheckoutSession HandleStripeWebhookRequest HandleStripeWebhookResponse Payment
    ListPaymentsRequest PaymentList BillingServiceClient BillingServiceController
    BillingServiceControllerMethods BILLING_SERVICE_NAME paymentSucceededPayload
    PaymentSucceededPayload PAYMENT_SUCCEEDED_EVENT`,
  '@domain/notifications-contracts': `notificationsV1 Notification Notification_DataEntry
    ListNotificationsRequest NotificationPage MarkNotificationReadRequest
    NotificationsServiceClient NotificationsServiceController
    NotificationsServiceControllerMethods NOTIFICATIONS_SERVICE_NAME NOTIFICATIONS_GRPC_PACKAGE
    NOTIFICATION_TYPES NotificationType notificationCreatedPayload NotificationCreatedPayload
    NOTIFICATION_CREATED_EVENT`,
  '@platform/contracts': `GrpcPackageSpec GrpcLoaderOptions GRPC_LOADER_OPTIONS
    ResolvedGrpcPackages GrpcMethodName resolveGrpcPackages EventEnvelopeSchema
    eventEnvelopeSchema EventEnvelope EventContract EventPayloadOf EventEnvelopeOf
    defineEventContract isEventContract eventEnvelopeSchemaFor parseEventEnvelope
    safeParseEventEnvelope EventEnvelopeMeta createEventEnvelope EVENT_TOPIC_PATTERN isEventTopic
    DeadLetterTopic deadLetterTopic topicVersion KAFKA_HEADERS KafkaHeader`,
};
const OWNER = new Map(
  Object.entries(OWNERS).flatMap(([pkg, names]) =>
    names
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, pkg]),
  ),
);
const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@platform\/contracts';/g;

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  const output = source.replace(IMPORT, (_match, typeOnly, list) => {
    const groups = new Map();
    for (const specifier of list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const name = specifier.replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      const pkg = OWNER.get(name);
      if (pkg === undefined) throw new Error(`${file}: no owner for "${name}"`);
      groups.set(pkg, [...(groups.get(pkg) ?? []), specifier]);
    }
    return [...groups]
      .map(([pkg, specifiers]) => {
        const types = typeOnly !== undefined || specifiers.every((s) => s.startsWith('type '));
        const names = types ? specifiers.map((s) => s.replace(/^type\s+/, '')) : specifiers;
        return `import ${types ? 'type ' : ''}{ ${names.join(', ')} } from '${pkg}';`;
      })
      .join('\n');
  });
  if (output !== source) {
    writeFileSync(file, output);
    console.info(`rewrote ${file}`);
  }
}
