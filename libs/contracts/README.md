# @app/contracts

The wire contracts between services, and nothing else:

- **gRPC**: `.proto` definitions (`src/proto/**`), the ts-proto NestJS output generated from them (`src/generated/**`, committed), and the package registry and proto-loader options that servers and clients share.
- **Kafka**: topic names, the event envelope, zod payload schemas, and parse/build helpers for integration events.

It is a leaf package: no Nest modules, no config, no `@app/*` dependencies. Transport wiring (servers, clients, producers, DLQ filters) lives in `@app/transport`.

## Public API

### gRPC (`src/grpc/grpc-packages.ts`)

| Export                       | Signature                                                                                                   | Notes                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PROTO_DIR`                  | `string`                                                                                                    | Resolves to `<pkg>/src/proto` in dev and `<pkg>/dist/proto` after the build (swc `copyFiles`).                                            |
| `GRPC_PACKAGES`              | `{ identity \| notifications \| billing: { package, protoPath, services, clientToken } }` (`as const`)      | `services` come from the generated `*_SERVICE_NAME` constants, so they cannot drift from the protos.                                      |
| `GrpcPackageName`            | `'identity' \| 'notifications' \| 'billing'`                                                                |                                                                                                                                           |
| `GrpcPackageSpec`            | interface                                                                                                   | The shape of one `GRPC_PACKAGES` entry.                                                                                                   |
| `GRPC_PACKAGE_NAMES`         | `readonly GrpcPackageName[]`                                                                                |                                                                                                                                           |
| `isGrpcPackageName(v)`       | `(value: unknown) => value is GrpcPackageName`                                                              |                                                                                                                                           |
| `GRPC_LOADER_OPTIONS`        | `{ keepCase: false, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }` | Use for **both** servers and clients. Mirrors `buf.gen.yaml`.                                                                             |
| `GrpcLoaderOptions`          | `NonNullable<GrpcOptions['options']['loader']>`                                                             |                                                                                                                                           |
| `resolveGrpcPackages(names)` | `(names: readonly GrpcPackageName[]) => { packages: string[]; protoPath: string[]; services: string[] }`    | Deduplicated. `services` are fully qualified (`identity.v1.AuthService`), which is the form health, reflection and service-config expect. |

### Generated gRPC types (flat, plus namespaces)

Every generated symbol is re-exported flat: messages (`User`, `AuthTokens`, `UserPage`, `Notification`, `NotificationPage`, `Payment`, `CheckoutSession`, …), `<Svc>Client` / `<Svc>Controller` interfaces, `<Svc>ControllerMethods()` class decorators and `<SVC>_SERVICE_NAME` constants, for `AuthService`, `UsersService`, `NotificationsService` and `BillingService`. `type Empty` is exported too.

The same modules are also exported as the namespaces `identityV1`, `notificationsV1` and `billingV1`. These are the escape hatch for when a `v2` package reuses message names.

**Why a flat barrel:** `exportCommonSymbols=false` removes the per-file `protobufPackage` and `<PKG>_PACKAGE_NAME` constants. Those were the only names that collided. tsc fails the build if two star exports ever clash.

### Kafka events (`src/events/*`)

| Export                                                                           | Signature                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAFKA_TOPICS`                                                                   | `{ USER_REGISTERED: 'identity.user-registered.v1', PAYMENT_SUCCEEDED: 'billing.payment-succeeded.v1', NOTIFICATION_CREATED: 'notifications.notification-created.v1' }` |
| `KafkaTopic`, `DeadLetterTopic<T>`                                               | Union of topic literals, and `` `${T}.dlq` ``                                                                                                                          |
| `KAFKA_TOPIC_VALUES`, `DEAD_LETTER_TOPIC_VALUES`                                 | `readonly` lists, used for topic provisioning                                                                                                                          |
| `deadLetterTopic(t)`                                                             | `<T extends KafkaTopic>(topic: T) => DeadLetterTopic<T>`                                                                                                               |
| `isKafkaTopic(v)`, `topicVersion(t)`                                             | Type guard; major version parsed from the `.vN` suffix                                                                                                                 |
| `KAFKA_HEADERS`, `KafkaHeader`                                                   | `x-event-type`, `x-correlation-id`, `x-original-topic`, `x-error-message`, `x-error-type`, `x-failed-at`                                                               |
| `eventEnvelopeSchema(payload)`                                                   | `<T extends z.ZodType>(payload: T) => EventEnvelopeSchema<T>`                                                                                                          |
| `EventEnvelope<T>`                                                               | `{ id; type; version; occurredAt; source; correlationId?; payload: T }`                                                                                                |
| `userRegisteredPayload`, `paymentSucceededPayload`, `notificationCreatedPayload` | zod schemas (types: `UserRegisteredPayload`, `PaymentSucceededPayload`, `NotificationCreatedPayload`)                                                                  |
| `NOTIFICATION_TYPES`, `NotificationType`                                         | `'welcome' \| 'payment_receipt' \| 'digest' \| 'system'`                                                                                                               |
| `EVENT_PAYLOAD_SCHEMAS`, `EVENT_ENVELOPE_SCHEMAS`                                | Topic → schema. Envelope schemas are built once at load time.                                                                                                          |
| `EventPayload<T>`, `EventEnvelopeFor<T>`                                         | Payload and envelope type of topic `T`                                                                                                                                 |
| `parseEventEnvelope(topic, raw)`                                                 | `<T extends KafkaTopic>(topic: T, raw: unknown) => EventEnvelopeFor<T>`. Throws `ZodError`, or `Error` for an unregistered topic.                                      |
| `safeParseEventEnvelope(topic, raw)`                                             | Returns `z.ZodSafeParseResult<EventEnvelopeFor<T>>`                                                                                                                    |
| `createEventEnvelope(topic, payload, meta)`                                      | `meta: { id; source; correlationId?; occurredAt? }`. Stamps `type`/`version`/`occurredAt` and validates.                                                               |

## Usage

```ts
// gRPC server options (@app/transport)
import { GRPC_LOADER_OPTIONS, resolveGrpcPackages } from '@app/contracts';
const { packages, protoPath, services } = resolveGrpcPackages(['identity']);
app.connectMicroservice(
  {
    transport: Transport.GRPC,
    options: { url, package: packages, protoPath, loader: GRPC_LOADER_OPTIONS },
  },
  { inheritAppConfig: true },
);

// gRPC controller (@app/identity)
import {
  type GetUserRequest,
  type User,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '@app/contracts';
@GrpcController()
@UsersServiceControllerMethods()
export class UsersGrpcController implements UsersServiceController {
  async getUser(request: GetUserRequest): Promise<User> {
    /* createdAt/updatedAt MUST be Date */
  }
}

// Kafka
import { KAFKA_TOPICS, createEventEnvelope, parseEventEnvelope } from '@app/contracts';
const envelope = createEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, payload, {
  id: generateId(),
  source: 'identity-service',
});
const event = parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, message); // event.payload is typed
```

## Codegen

```bash
bun run proto:lint   # buf STANDARD, minus the two response-naming rules (see buf.yaml)
bun run proto:gen    # buf generate + scripts/proto-esm-fix.mjs (needs `node` on PATH)
buf breaking --against '.git#branch=master,subdir=libs/contracts'   # CI breaking-change gate
```

After changing a `.proto`, regenerate and commit `src/generated/**`. Biome, ESLint and Prettier ignore that directory. The post-gen script rewrites `import { wrappers } from "protobufjs"`, which crashes under native ESM, into a default import. It also changes cross-file `*.pb.js` imports to `import type` (for `verbatimModuleSyntax`), and fails if ts-proto's output shape changes.

## Env vars

None. URLs, deadlines and message sizes live in `grpcConfig` (`@app/config`), and Kafka settings in `kafkaConfig`.

## Gotchas

- **Timestamp ↔ Date only works if the generated modules are evaluated** before the first (de)serialisation, because ts-proto patches the shared `protobufjs` instance. Importing any value from `@app/contracts` does this (`grpc-packages.ts` imports the generated modules for this side effect). A process that imports only types gets `{ seconds, nanos }`.
- Keep a single `protobufjs@7.x`, the one `@grpc/proto-loader` uses. A second copy (for example v8) silently disables the Date mapping.
- Server handlers must return a `Date` for Timestamp fields. An ISO string throws `object expected`.
- `defaults: true` decodes absent **message** fields as `null`, even though the TS type says `undefined`. Test with `== null`. A present proto3 `optional` also carries a synthetic `_field` key. Map decoded objects to DTOs instead of returning them verbatim to REST.
- int64 fields (`Payment.amountTotal`, `LogoutRequest.accessTokenExp`) are **decimal strings**. Kafka payloads use JSON numbers for amounts, which is safe below 2^53.
- `HandleStripeWebhookRequest.payload` is a `Buffer`. Pass the raw body byte-for-byte, because the signature is computed over it.
- The `<Svc>ControllerMethods()` decorators need `reflect-metadata` loaded by the entrypoint.
- Event schemas strip unknown keys (tolerant reader). Breaking payload changes need a new `.v2` topic.
- `docker`: the runtime image needs `libs/contracts/dist/**`, which includes `dist/proto/**`.
