# @platform/contracts

The generic half of the wire contracts. Each domain publishes its own contracts package (`domains/<x>/contracts`, `@domain/<x>-contracts`: its `.proto`, the ts-proto output, one `GrpcPackageSpec` per protobuf package and one `EventContract` per Kafka topic), built on the types below. `@platform/transport` only ever takes those values, never a package or topic name, so no platform package names a domain.

It is a leaf package: no Nest modules, no config, no workspace dependencies. It also holds the codegen tooling every contracts package shares: the buf policy (`buf.yaml`), the ts-proto template (`buf.gen.yaml`) and the ESM post-processor (`scripts/proto-esm-fix.mjs`).

## Public API

### gRPC (`src/grpc/grpc-package-spec.ts`)

| Export                       | Signature                                                                                                  | Notes                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GrpcPackageSpec`            | `{ package; protoDir; protoPath; services; clientToken; idempotentMethods }`                               | One per protobuf package, exported by its contracts package (`ORDERS_GRPC_PACKAGE`, …). `protoDir` is the package's `src/proto` (sources) or `dist/proto`. |
| `GRPC_LOADER_OPTIONS`        | `{ keepCase: false, longs: String, enums: String, defaults: true, oneofs: true }`                          | Use for **both** servers and clients. Mirrors `buf.gen.yaml`. `includeDirs` comes from `resolveGrpcPackages`.                                              |
| `GrpcLoaderOptions`          | `NonNullable<GrpcOptions['options']['loader']>`                                                            |                                                                                                                                                            |
| `resolveGrpcPackages(specs)` | `(specs: readonly GrpcPackageSpec[]) => { packages; protoPath; includeDirs; services; idempotentMethods }` | Deduplicated by `package`. `services` are fully qualified (`orders.v1.OrdersService`), the form health, reflection and service config expect.              |
| `GrpcMethodName`             | `{ service; method }`                                                                                      | An idempotent rpc, as gRFC A6 `methodConfig[].name[]` expects it.                                                                                          |

### Kafka events (`src/events/*`)

| Export                                                                  | Signature                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `EventContract<TPayload>`                                               | `{ readonly topic: string; readonly payload: z.ZodType<TPayload> }`, one per topic                          |
| `defineEventContract(topic, payload)`                                   | A frozen contract; throws at module load when `topic` breaks `<context>.<event-name>.v<major>`              |
| `isEventContract(value)`                                                | Type guard (scripts scan module namespaces with it)                                                         |
| `EventPayloadOf<C>`, `EventEnvelopeOf<C>`                               | Payload and envelope type of a contract                                                                     |
| `eventEnvelopeSchemaFor(contract)`                                      | The contract's envelope schema, built once per contract object                                              |
| `parseEventEnvelope(contract, raw)`, `safeParseEventEnvelope(...)`      | Validate a message value. `parse` throws `ZodError`                                                         |
| `createEventEnvelope(contract, payload, meta)`                          | `meta: { id; source; correlationId?; occurredAt? }`. Stamps `type`/`version`/`occurredAt` and validates     |
| `eventEnvelopeSchema(payload)`, `EventEnvelope<T>`, `EventEnvelopeMeta` | The envelope builder and wire type: `{ id; type; version; occurredAt; source; correlationId?; payload: T }` |
| `EVENT_TOPIC_PATTERN`, `isEventTopic(v)`, `topicVersion(t)`             | Topic naming convention, type guard, major version parsed from the `.vN` suffix                             |
| `deadLetterTopic(t)`, `DeadLetterTopic<T>`                              | `` `${T}.dlq` ``                                                                                            |
| `KAFKA_HEADERS`, `KafkaHeader`                                          | `x-event-type`, `x-correlation-id`, `x-original-topic`, `x-error-message`, `x-error-type`, `x-failed-at`    |

### `@platform/contracts/testing`

`loadGrpcPackages(specs)`, `wireRoundTrip(root, typeName, value)`, `protoFilesUnder(dir)` and `boundRpcPatterns(decorator, service)`: proto-loader semantics without a server, for the wire-format specs of the contracts packages. Never imported by production code.

## Usage

```ts
// A contracts package (domains/orders/contracts/src/events/orders.events.ts)
export const orderPlacedPayload = z.object({ orderId: z.uuid(), amountTotal: z.number().int() });
export type OrderPlacedPayload = z.infer<typeof orderPlacedPayload>;
export const ORDER_PLACED_EVENT: EventContract<OrderPlacedPayload> = defineEventContract(
  'orders.order-placed.v1',
  orderPlacedPayload,
);

// Anywhere (producer, consumer, test)
const envelope = createEventEnvelope(ORDER_PLACED_EVENT, payload, {
  id: generateId(),
  source: 'orders-service',
});
const event = parseEventEnvelope(ORDER_PLACED_EVENT, message); // event.payload is typed
```

## Codegen

Every contracts package runs the shared tooling from its own folder (`bun run proto:gen` / `bun run proto:lint` at the root run them all):

```bash
buf lint --config ../../../libs/contracts/buf.yaml
buf generate --template ../../../libs/contracts/buf.gen.yaml --config ../../../libs/contracts/buf.yaml
node ../../../libs/contracts/scripts/proto-esm-fix.mjs src/generated
```

`buf.yaml` declares the module as `src/proto`, relative to the folder buf runs in. buf rejects module paths outside that folder, so one workspace listing every domain is impossible. The post-gen script rewrites `import { wrappers } from "protobufjs"`, which crashes under native ESM, into a default import, changes cross-file `*.pb.js` imports to `import type` (for `verbatimModuleSyntax`), and fails if ts-proto's output shape changes.

## Gotchas

- **Timestamp ↔ Date only works if the generated module was evaluated** before the first (de)serialisation, because ts-proto patches the shared `protobufjs` instance. Each `<X>_GRPC_PACKAGE` value-imports its generated module, and transport only builds options from specs, so every gRPC process registers it. A process that imports only types gets `{ seconds, nanos }`.
- Keep a single `protobufjs@7.x`, the one `@grpc/proto-loader` uses. A second copy (for example v8) silently disables the Date mapping.
- `defaults: true` decodes absent **message** fields as `null`, even though the TS type says `undefined`. A present proto3 `optional` also carries a synthetic `_field` key. int64 fields are **decimal strings**.
- Event schemas strip unknown keys (tolerant reader). Breaking payload changes need a new `.v2` topic.
- `protoPath` entries are relative to their own `protoDir`; keep them namespaced (`<context>/v1/<context>.proto`) so two packages never resolve the same relative path.
