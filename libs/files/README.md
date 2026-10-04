# @app/files

The **files** bounded context: per-user object storage on S3-compatible stores or GCS.

- streamed multipart uploads: the bytes go from the socket to the bucket without a whole-file buffer, but the
  storage driver holds bounded chunks (S3: up to ~15 MiB per upload), so they are capped per process
  (`STORAGE_MAX_CONCURRENT_UPLOADS`, 503 + `Retry-After` beyond it). Prefer presigned uploads for large files.
- presigned upload URLs (direct browser → bucket `PUT`) and presigned download URLs
- deletes
- ownership by key prefix; `files:manage` (admins) bypasses it

The context is **edge-only**. There is no files microservice, so there is no Core/Grpc/Api module
split and no port pair for the use cases. The gateway and the monolith import the same
`FilesModule`. The hexagonal seam is the `StorageService` port from `@app/storage`, which is bound
to the S3, GCS or in-memory driver.

## Layout

```
src/
  files.constants.ts       USER_FILES_ROOT, UPLOAD_FILE_FIELD, content-type allow-list (+ regex), size ceilings
  files.module.ts          FilesModule
  domain/                  files.errors.ts (FilesErrorCode + 4 DomainExceptions), file-content-type.ts (allow-list policy)
  application/             files.service.ts (use cases), file-key.ts (key building / ownership), file-access.policy.ts, files.types.ts
  presentation/http/       FilesController, zod request DTOs, zod response schemas + mappers, multipart options, ApiMultipartFileBody
  presentation/graphql/    FilesResolver, CreateUploadUrlInput, PresignedUploadModel, mapper
  testing/                 files-test-app.test.ts (Fastify test app; `*.test.ts` = not built, not collected)
```

## Wiring (gateway and monolith)

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

`FilesModule` imports `ConfigModule.forFeature(storageConfig)` and
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
users/{userId}/{uuidv7}-{safeFilename}      e.g. users/01a0…/01a0…-quarterly-report.pdf
```

- The uuidv7 makes every upload a new, time-ordered and unguessable object, so nothing is
  overwritten and keys cannot be enumerated. `toSafeFilename` (from @app/common) strips paths,
  deburrs and kebab-cases the name, keeps the extension and caps it at 120 characters.
- Stored metadata: `uploaded-by: {userId}` (`x-amz-meta-uploaded-by` / GCS custom metadata), and
  the normalized content type.
- Ownership: `isKeyWithinPrefix(key, 'users/{userId}')`, which does not confuse `users/u1` with
  `users/u10`. It always runs after `assertStorageKey` (`resolveFileAccess`), so a key such as
  `users/me/../you/x` is rejected before the prefix test. REST already rejects it with a 400. User
  ids containing `/` are refused, because such an id would nest one user's prefix inside another's.

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
- Access is checked before existence, so users cannot probe other users' keys (403 before 404).
  Uses of the admin bypass are logged (`files:manage download|delete of <key> by <id>`).

## Errors (`FilesErrorCode`)

| Class                             | Status | Code                       | When                                                                                                                                                                            |
| --------------------------------- | ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileAccessDeniedException`       | 403    | `FILE_ACCESS_DENIED`       | The key is outside the caller's prefix and the caller lacks `files:manage`. The key is not echoed.                                                                              |
| `FileNotFoundException`           | 404    | `FILE_NOT_FOUND`           | Download URL requested for a missing (authorized) key.                                                                                                                          |
| `FileTooLargeException`           | 413    | `FILE_TOO_LARGE`           | The multipart stream overflowed, or the announced `contentLength` is too big. `errors[0]` (path `file` or `contentLength`) states the limit.                                    |
| `UnsupportedFileTypeException`    | 415    | `UNSUPPORTED_FILE_TYPE`    | The type is not in the allow-list.                                                                                                                                              |
| `UploadCapacityExceededException` | 503    | `UPLOAD_CAPACITY_EXCEEDED` | `STORAGE_MAX_CONCURRENT_UPLOADS` streamed uploads are already in flight in this process. Raised before the body is read; REST adds `Retry-After: 5` (`UPLOAD_RETRY_AFTER_SEC`). |

Malformed keys that reach the service (for example over GraphQL, or from other callers) raise
@app/storage's 422 `INVALID_STORAGE_KEY`. Storage outages raise its 502 `STORAGE_ERROR`.

## Configuration (`storage` namespace)

`STORAGE_MAX_UPLOAD_BYTES` (26214400) caps streamed uploads through the multipart `limits.fileSize`
and presigned uploads through the announced `contentLength`. `STORAGE_MAX_CONCURRENT_UPLOADS` (4) caps
streamed uploads in flight per process (per replica / cluster worker); presigned uploads are not
counted. Memory budget: each streamed upload holds up to ~15 MiB of off-heap Buffers (S3 driver:
`(S3_UPLOAD_QUEUE_SIZE + 1) × S3_UPLOAD_PART_SIZE`), outside `--max-old-space-size`, so keep
`cap × 15 MiB` well below `container memory − max-old-space-size` (gateway: 4 × 15 = 60 MiB of
512 − 384 = 128 MiB). `STORAGE_SIGNED_URL_TTL_SEC` (900) is
the lifetime of presigned URLs. See `@app/storage` for the driver variables (`STORAGE_DRIVER`, `S3_*`,
`GCS_*`).

## Public API (`src/index.ts`)

- `FilesModule`, `FilesService` (`upload`, `createUploadUrl`, `createDownloadUrl`, `deleteFile`, `maxUploadBytes`), `UPLOADED_BY_METADATA_KEY`
- `FilesController`, `FilesResolver`, `CreateUploadUrlInput`, `PresignedUploadModel`, `PresignedUploadHeaderModel`
- zod schemas and types: `CreatePresignedUploadBodySchema`, `FileKeyQuerySchema`, `UploadedFileResponseSchema`, `PresignedUploadResponseSchema`, `DownloadUrlResponseSchema`
- key and access helpers: `buildUserFileKey`, `userFilesPrefix`, `isFileKeyOwnedBy`, `isValidFileKey`, `filenameOfFileKey`, `resolveFileAccess`
- content-type policy: `isAllowedContentType`, `assertAllowedContentType`, `normalizeContentType`
- errors: `FilesErrorCode`, `FileAccessDeniedException`, `FileNotFoundException`, `FileTooLargeException`, `UnsupportedFileTypeException`
- constants: `USER_FILES_ROOT`, `UPLOAD_FILE_FIELD`, `MAX_FILENAME_LENGTH`, `MAX_PRESIGNED_UPLOAD_BYTES`, `ALLOWED_UPLOAD_CONTENT_TYPES`, `ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN`
- types: `FileActor`, `UploadFileParams`, `UploadedFile`, `UploadUrlParams`, `FileUploadUrl`, `FileDownloadUrl`, `FileAccess`

## Tests (`bunx vitest run --project files`; no infrastructure needed)

- `files.controller.spec.ts` runs a Fastify test app built from the real `AuthModule` guards,
  the common enhancers, `StorageModule({ driver: 'memory' })` and real JWTs from `TokenService`.
  It covers:
  - real multipart uploads through `app.inject` with a `FormData` payload; storage receives a
    `Readable`, not a buffer
  - an upload of exactly the limit (201) and an upload over the limit (413 `FILE_TOO_LARGE`, nothing stored)
  - 415, and 400 for a missing file, a file in the wrong field or extra fields
  - 503 `UPLOAD_CAPACITY_EXCEEDED` + `Retry-After` over `STORAGE_MAX_CONCURRENT_UPLOADS`, and the slot freed afterwards
  - 401 anonymous or forged, and 403 without `files:write`
  - presign 201, zod 400s (strict body) and 413
  - download: own file 200, another user's 403, the `u1`/`u10` boundary, admin bypass, 404, and
    400 for traversal keys
  - delete: 204, idempotency, 403 with the file kept, admin bypass
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
