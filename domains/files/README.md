# @domain/files

The **files** bounded context: per-user object storage on S3-compatible stores or GCS, keyed by the caller's
active tenant.

- streamed multipart uploads: the bytes go from the socket to the bucket without a whole-file buffer, but the
  storage driver holds bounded chunks (S3: up to ~15 MiB per upload), so they are capped per process
  (`STORAGE_MAX_CONCURRENT_UPLOADS`, 503 + `Retry-After` beyond it). Prefer presigned uploads for large files.
- presigned upload URLs (direct browser → bucket `PUT`) and presigned download URLs
- deletes
- ownership by key prefix inside the active tenant; `files:manage` (admins and owners) reaches any file of the active
  tenant, never another tenant's

The context is **edge-only**. There is no files microservice, so there is no Core/Grpc/Api module
split and no port pair for the use cases. The gateway and the monolith import the same
`FilesModule`. The hexagonal seam is the `StorageService` port from `@platform/storage`, which is bound
to the S3, GCS or in-memory driver.

## Layout

```
src/
  files.constants.ts       TENANT_FILES_ROOT, USER_FILES_ROOT, UPLOAD_FILE_FIELD, content-type allow-list (+ regex), size ceilings
  api/index.ts             the ./api entry: FilesModule + its config namespace (what the gateway imports)
  files.module.ts          FilesModule
  domain/                  files.errors.ts (FilesErrorCode + 5 DomainExceptions), file-content-type.ts (allow-list policy)
  application/             files.service.ts (use cases), file-key.ts (key building / ownership), file-access.policy.ts, files.types.ts
  presentation/http/       FilesController, zod request DTOs, zod response schemas + mappers, multipart options, ApiMultipartFileBody
  presentation/graphql/    FilesResolver, CreateUploadUrlInput, PresignedUploadModel, mapper
  testing/                 files-test-app.test.ts (Fastify test app; `*.test.ts` = not built, not collected)
```

## Wiring (gateway and monolith)

Entry points: `@domain/files/api` (`FilesModule` and its config namespace; what the gateway and monolith import)
and `@domain/files` (everything in `./api` plus the service, policies, DTOs and errors). No `./testing`.

```ts
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    RedisModule.forRootAsync(),
    AuthModule.forRootAsync(), // global JwtAuthGuard → RolesGuard → PermissionsGuard
    AppThrottlerModule.forRootAsync(),
    AppGraphqlModule.forRootAsync(), // optional: serves Mutation.createUploadUrl
    StorageModule.forRootAsync(), // global StorageService (STORAGE_DRIVER)
    FilesModule,
  ],
  providers: [...provideCommonEnhancersAsync({ … })], // validation pipes + problem+json filter
})
export class AppModule {}

// main.ts: createHttpApp(AppModule, { multipart: true }) is recommended. Without it, the Fastify
// adapter registers @fastify/multipart on first use anyway, and FilesModule's own limits win in both cases.
```

`FilesModule` imports `ConfigModule.forFeature(filesConfig)` (its own `files` namespace) and
`MultipartModule.registerAsync(...)`. The second one makes `limits.fileSize = STORAGE_MAX_UPLOAD_BYTES`
the default of the upload interceptor, because a decorator argument cannot read config. It
provides `FilesService` and `FilesResolver`, registers `FilesController` and exports
`FilesService`. It needs no database, Redis, Kafka or gRPC client of its own.

## REST (`/v1/files`, bearer JWT; errors are RFC 9457 `application/problem+json`)

| Method & path                      | Permission                      | Input                                                                                                                               | Success                                                         | Errors                                                                                                                                                        |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/files`                   | `files:write`                   | `multipart/form-data` with one `file` part and no other parts (`FileStreamInterceptor`)                                             | `201 { key, filename, contentType, size?, etag? }`              | 400 (no file part, other field, extra parts), 401, 403, **413 `FILE_TOO_LARGE`**, 415 `UNSUPPORTED_FILE_TYPE`, 503 `UPLOAD_CAPACITY_EXCEEDED` + `Retry-After` |
| `POST /v1/files/presigned-uploads` | `files:write`                   | zod body (`@Body({ schema })`, strict): `filename` (1–255), `contentType` (allow-list, case-insensitive), `contentLength` (int ≥ 1) | `201 { key, filename, url, method: 'PUT', headers, expiresAt }` | 400 (zod), 401, 403, 413 `FILE_TOO_LARGE` (`contentLength` > `STORAGE_MAX_UPLOAD_BYTES`)                                                                      |
| `GET /v1/files/download-url?key=`  | `files:read` or `files:manage`  | zod query: `key` (valid storage key)                                                                                                | `200 { key, filename, url, expiresAt, size, contentType? }`     | 400, 401, 403 `FILE_ACCESS_DENIED`, 404 `FILE_NOT_FOUND`                                                                                                      |
| `DELETE /v1/files?key=`            | `files:write` or `files:manage` | zod query: `key`                                                                                                                    | `204` (idempotent)                                              | 400, 401, 403 `FILE_ACCESS_DENIED`                                                                                                                            |

- Swagger/OpenAPI: `@ApiTags('Files')`, `@ApiBearerAuth()`, `@ApiOperation` and a response
  decorator for each status. The upload body is documented by `@ApiMultipartFileBody()`
  (`multipart/form-data`, binary `file`, plus an encoding with the allowed types). The zod body and
  query are converted natively: the body becomes `components.schemas.CreatePresignedUploadRequest`,
  and the query is expanded into a `key` parameter.
- Responses are serialized through their zod schemas: `@SerializeOptions({ schema })` plus a
  controller-scoped `StandardSchemaSerializerInterceptor`. Unknown keys are stripped, and dates are
  ISO strings.
- The upload route sets `@Timeout(0)`. Fastify's `requestTimeout` (`HTTP_REQUEST_TIMEOUT_MS`,
  30 s by default) and the storage client's timeouts bound the upload instead, because an
  interceptor 504 would race a client that is still sending the body. Raise
  `HTTP_REQUEST_TIMEOUT_MS`, or better use presigned uploads, for large files on slow links.

## GraphQL

| Operation                                                                  | Permission    | Notes                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutation createUploadUrl(input: CreateUploadUrlInput!): PresignedUpload!` | `files:write` | `CreateUploadUrlInput { filename: String!, contentType: String!, contentLength: Int! }` (class-validator on every field). `PresignedUpload { key, filename, url, method, headers: [PresignedUploadHeader!]!, expiresAt: DateTime! }`. |

The global guards are context-aware, so authentication and permissions work unchanged. File bytes
are never sent over GraphQL: only the presigned flow is exposed there.

## Data model

There is no database. The object key is the record:

```
tenants/{tenantId}/users/{userId}/{uuidv7}/{safeFilename}
  e.g. tenants/0190…/users/01a0…/01a0…/quarterly-report.pdf
```

- `buildUserFileKey(tenantId, userId, filename)` is the only builder; `tenantFilesPrefix(tenantId)` and
  `userFilesPrefix(tenantId, userId)` give the two "directories". The tenant always comes from the token
  (`AuthUser.tenantId`), never from the request. It must be a UUID (stored lower-cased) and never the platform
  tenant; the user id must be one non-empty segment without `/`.
- The uuidv7 makes every upload a new, time-ordered and unguessable object, so nothing is
  overwritten and keys cannot be enumerated. `toSafeFilename` (from @platform/common) strips paths,
  deburrs and kebab-cases the name, keeps the extension and caps it at 120 characters. The last
  segment is the download filename (`filenameOfFileKey`).
- Stored metadata on streamed uploads: `uploaded-by: {userId}` and `tenant-id: {tenantId}`
  (`x-amz-meta-*` / GCS custom metadata), and the normalized content type. Presigned uploads carry
  no metadata (the client sends the PUT).
- Access (`resolveFileAccess(actor, key)`), in this order:
  1. `assertStorageKey(key)`: a malformed key (`tenants/A/../B/…`) is 422 `INVALID_STORAGE_KEY`
     (REST already rejects it with a 400);
  2. a key not strictly under `tenants/{actor.tenantId}` is `denied`, whatever the permissions: every other
     tenant's key and every legacy `users/…` key;
  3. a key strictly under `tenants/{actor.tenantId}/users/{actor.id}` is `owner`;
  4. `files:manage` is `manager` (logged);
  5. otherwise `denied`.
     The prefix tests are segment-aware (`users/u1` never matches `users/u10`, nor a tenant id one character
     longer).

### Keys from before B4 (`users/{userId}/…`)

Objects uploaded before tenant-scoped keys stay in the bucket but are unreachable through the API: every caller,
`files:manage` included, gets 403. Nothing copies them. In development, empty the bucket with the same reset as the
other stores (`docker compose down -v`). An adopter who keeps objects moves each user's folder into the tenant it
belongs to (usually the user's personal workspace), with the provider CLI:

```sh
aws s3 mv --recursive "s3://$S3_BUCKET/users/$USER_ID/" "s3://$S3_BUCKET/tenants/$TENANT_ID/users/$USER_ID/"   # S3, RustFS (add --endpoint-url)
gcloud storage mv "gs://$GCS_BUCKET/users/$USER_ID/*" "gs://$GCS_BUCKET/tenants/$TENANT_ID/users/$USER_ID/"    # GCS
```

A moved object keeps its old last segment (`{uuidv7}-{safeFilename}`), which then becomes its download filename.

## Security notes

- Content-type allow-list (`ALLOWED_UPLOAD_CONTENT_TYPES`): png, jpeg, gif, webp, avif, pdf,
  json, zip, text/plain, text/csv, mpeg audio, mp4 video. `image/svg+xml` and `text/html` are
  excluded on purpose (stored XSS). Streamed uploads are checked in the multipart `fileFilter`
  before a single byte is read, and `FilesService` checks again.
- The **declared** type is checked; the content is not sniffed (no magic bytes). Downloads are
  therefore always presigned with `Content-Disposition: attachment`, so browsers never render
  uploads inline.
- Presigned PUTs sign the content type and the exact `contentLength`. The announced size is
  checked against `STORAGE_MAX_UPLOAD_BYTES` and against the 5 GiB single-PUT ceiling.
- Access is checked before existence, so users cannot probe other users' or tenants' keys (403
  before 404). Uses of `files:manage` are logged
  (`files:manage download|delete of <key> by <id> in tenant <tenantId>`).

## Errors (`FilesErrorCode`)

| Class                             | Status | Code                       | When                                                                                                                                                                            |
| --------------------------------- | ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileAccessDeniedException`       | 403    | `FILE_ACCESS_DENIED`       | The key is outside the caller's active tenant, or outside their own prefix and they lack `files:manage`. The key is not echoed.                                                 |
| `FileNotFoundException`           | 404    | `FILE_NOT_FOUND`           | Download URL requested for a missing (authorized) key.                                                                                                                          |
| `FileTooLargeException`           | 413    | `FILE_TOO_LARGE`           | The multipart stream overflowed, or the announced `contentLength` is too big. `errors[0]` (path `file` or `contentLength`) states the limit.                                    |
| `UnsupportedFileTypeException`    | 415    | `UNSUPPORTED_FILE_TYPE`    | The type is not in the allow-list.                                                                                                                                              |
| `UploadCapacityExceededException` | 503    | `UPLOAD_CAPACITY_EXCEEDED` | `STORAGE_MAX_CONCURRENT_UPLOADS` streamed uploads are already in flight in this process. Raised before the body is read; REST adds `Retry-After: 5` (`UPLOAD_RETRY_AFTER_SEC`). |

Malformed keys that reach the service (for example over GraphQL, or from other callers) raise
@platform/storage's 422 `INVALID_STORAGE_KEY`. Storage outages raise its 502 `STORAGE_ERROR`.

## Configuration (`files` namespace, `src/files.config.ts`)

`STORAGE_MAX_UPLOAD_BYTES` (26214400) caps streamed uploads through the multipart `limits.fileSize`
and presigned uploads through the announced `contentLength`. `STORAGE_MAX_CONCURRENT_UPLOADS` (4)
caps streamed uploads in flight per process (per replica / cluster worker); presigned uploads are
not counted. Memory budget: each streamed upload holds up to ~15 MiB of off-heap Buffers (S3 driver:
`(S3_UPLOAD_QUEUE_SIZE + 1) × S3_UPLOAD_PART_SIZE`), outside `--max-old-space-size`, so keep
`cap × 15 MiB` well below `container memory − max-old-space-size` (gateway: 4 × 15 = 60 MiB of
512 − 384 = 128 MiB). The variables keep their `STORAGE_` names. `STORAGE_SIGNED_URL_TTL_SEC` (900,
platform `storage` namespace) is the lifetime of presigned URLs. See `@platform/storage` for the
driver variables (`STORAGE_DRIVER`, `S3_*`, `GCS_*`).

## Public API (`src/index.ts`)

- `FilesModule`, `FilesService` (`upload`, `createUploadUrl`, `createDownloadUrl`, `deleteFile`, `maxUploadBytes`), `UPLOADED_BY_METADATA_KEY`, `TENANT_ID_METADATA_KEY`, `filesConfig` / `FilesConfig` (the `files` namespace)
- `FilesController`, `FilesResolver`, `CreateUploadUrlInput`, `PresignedUploadModel`, `PresignedUploadHeaderModel`
- zod schemas and types: `CreatePresignedUploadBodySchema`, `FileKeyQuerySchema`, `UploadedFileResponseSchema`, `PresignedUploadResponseSchema`, `DownloadUrlResponseSchema`
- key and access helpers: `buildUserFileKey`, `tenantFilesPrefix`, `userFilesPrefix`, `isFileKeyOwnedBy`, `isValidFileKey`, `filenameOfFileKey`, `resolveFileAccess`
- content-type policy: `isAllowedContentType`, `assertAllowedContentType`, `normalizeContentType`
- errors: `FilesErrorCode`, `FileAccessDeniedException`, `FileNotFoundException`, `FileTooLargeException`, `UnsupportedFileTypeException`
- constants: `TENANT_FILES_ROOT`, `USER_FILES_ROOT`, `UPLOAD_FILE_FIELD`, `MAX_FILENAME_LENGTH`, `MAX_PRESIGNED_UPLOAD_BYTES`, `ALLOWED_UPLOAD_CONTENT_TYPES`, `ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN`
- types: `FileActor`, `UploadFileParams`, `UploadedFile`, `UploadUrlParams`, `FileUploadUrl`, `FileDownloadUrl`, `FileAccess`

## Tests (`bunx vitest run --project files`; no infrastructure needed)

- `files.controller.spec.ts` runs a Fastify test app built from the real `AuthModule` guards,
  the common enhancers, `StorageModule({ driver: 'memory' })` and real JWTs from `signTestAccessToken` (`@platform/auth/testing`).
  It covers:
  - real multipart uploads through `app.inject` with a `FormData` payload; storage receives a
    `Readable`, not a buffer
  - an upload of exactly the limit (201) and an upload over the limit (413 `FILE_TOO_LARGE`, nothing stored)
  - 415, and 400 for a missing file, a file in the wrong field or extra fields
  - 503 `UPLOAD_CAPACITY_EXCEEDED` + `Retry-After` over `STORAGE_MAX_CONCURRENT_UPLOADS`, and the slot freed afterwards
  - 401 anonymous or forged, and 403 without `files:write`
  - presign 201, zod 400s (strict body) and 413
  - download: own file 200, another user's 403, the `u1`/`u10` boundary, an admin of the tenant 200,
    an admin of another tenant 403, a legacy `users/…` key 403, 404, and 400 for traversal keys
  - delete: 204, idempotency, 403 with the file kept, an admin of the tenant 204, an admin of another
    tenant 403
  - a full round trip
  - the generated OpenAPI document (multipart body, zod body `$ref`, `key` query parameter)
- `files-multipart-limits.spec.ts` covers an adapter that pre-registers `@fastify/multipart` with
  bigger or smaller limits (as `createHttpApp({ multipart: true })` does). `STORAGE_MAX_UPLOAD_BYTES`
  wins in both directions.
- `files.service.spec.ts` tests the use cases with `InMemoryStorageService` and `createMock<StorageService>`.
- `files.resolver.spec.ts` covers the code-first schema, built with `GraphQLSchemaFactory` and
  validated by introspection. It also covers resolver mapping, class-validator input rules, and
  `PermissionsGuard` in a GraphQL execution context.
- Other specs: `file-key.spec.ts`, `file-access.policy.spec.ts`, `file-content-type.spec.ts`,
  `files.errors.spec.ts` (problem+json mapping) and `files-http.mapper.spec.ts`.
