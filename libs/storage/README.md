# @app/storage

Driver-agnostic object storage. Consumers inject the abstract `StorageService`, and `StorageModule`
binds it to the **S3** driver (AWS, RustFS, MinIO, R2, …) or the **GCS** driver according to
`STORAGE_DRIVER`. Browser traffic goes through presigned URLs, so file bytes never pass through the
API process. Server-side ingestion streams the body in bounded chunks (never one whole-file buffer, but
not zero-copy either: see the memory note below).

## Public API

| Export                                                                                                                                                                                                                                             | Kind          | Purpose                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StorageModule.forRootAsync(options?: { driver?: 's3' \| 'gcs' \| 'memory' })`                                                                                                                                                                     | global module | Binds `StorageService` to the selected driver (loads `ConfigModule.forFeature(storageConfig)`). `driver` overrides the env, e.g. `'memory'` in e2e tests.                                                                             |
| `StorageService` (abstract, DI token)                                                                                                                                                                                                              | port          | `driver`, `upload(input)`, `createPresignedUpload(key, { contentType, contentLength?, expiresInSec? })`, `createPresignedDownload(key, { expiresInSec?, filename? })`, `head(key)` (`null` when missing), `delete(key)` (idempotent). |
| `createStorageService(cfg, driver?)`                                                                                                                                                                                                               | function      | Same selection logic without Nest (scripts/tests).                                                                                                                                                                                    |
| `S3StorageDriver(cfg, clients?: { client?, presignClient? })`, `createS3Client(s3, endpoint?)`, `S3_UPLOAD_PART_SIZE` (5 MiB), `S3_UPLOAD_QUEUE_SIZE` (2)                                                                                          | S3 driver     | lib-storage `Upload` (single PUT when the body fits in one part, else concurrent multipart; aborted on failure), SigV4 presigning on `S3_PUBLIC_ENDPOINT`, `onModuleDestroy` closes the keep-alive sockets.                           |
| `GcsStorageDriver(cfg, storage?)`, `createGcsClient(gcs)`, `isGoogleStorageEndpoint(url)`                                                                                                                                                          | GCS driver    | `createWriteStream({ resumable: false })` + `pipeline`, crc32c validation, v4 signed URLs.                                                                                                                                            |
| `InMemoryStorageService(options?)`                                                                                                                                                                                                                 | test double   | Same contract (key validation, TTL clamping…), fake `memory://` URLs, plus `getObject`, `listKeys`, `clear`.                                                                                                                          |
| `assertStorageKey`, `buildStorageKey(...segments)`, `isKeyWithinPrefix(key, prefix)`, `attachmentContentDisposition(filename)`, `resolveSignedUrlTtlSec`, `unquoteEtag`, `MAX_STORAGE_KEY_BYTES`, `MAX_SIGNED_URL_TTL_SEC`, `INVALID_STORAGE_KEY`  | utils         | Key safety and presign helpers.                                                                                                                                                                                                       |
| `toStorageException`, `isNetworkError`, `STORAGE_ERROR`                                                                                                                                                                                            | errors        | SDK/network failure → `ExternalServiceException` (502, generic message).                                                                                                                                                              |
| `UploadInput`, `StoredObject`, `PresignUploadOptions`, `PresignedUpload`, `PresignDownloadOptions`, `PresignedDownload`, `ObjectHead`, `StorageDriverName`, `S3StorageClients`, `InMemoryObject`, `InMemoryStorageOptions`, `StorageModuleOptions` | types         |                                                                                                                                                                                                                                       |

Errors: invalid keys throw `DomainValidationException` with code `INVALID_STORAGE_KEY` (422) before
any network call. Storage backend failures throw `ExternalServiceException` with code `STORAGE_ERROR`
(502). Any other error is rethrown unchanged, for example a `PayloadTooLargeException` from the
client's multipart stream.

## Usage

```ts
@Module({ imports: [AppConfigModule.forRoot(), StorageModule.forRootAsync()] })
export class AppModule {}

@Injectable()
export class FilesService {
  constructor(private readonly storage: StorageService) {}

  async upload(userId: string, file: MultipartFileStream): Promise<StoredObject> {
    const key = buildStorageKey(
      'users',
      userId,
      `${generateId()}-${toSafeFilename(file.originalname)}`,
    );
    return this.storage.upload({ key, body: file.stream, contentType: file.mimetype });
  }

  presign(key: string, contentType: string, size: number): Promise<PresignedUpload> {
    // The client must PUT to `url` with exactly `headers`.
    return this.storage.createPresignedUpload(key, { contentType, contentLength: size });
  }
}

// e2e tests
StorageModule.forRootAsync({ driver: 'memory' });
```

## Environment (`storage` namespace)

`STORAGE_DRIVER` (`s3`|`gcs`, default `s3`), `STORAGE_SIGNED_URL_TTL_SEC` (900),
`STORAGE_MAX_UPLOAD_BYTES` (read by `@app/files`), `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (defaults to
`S3_ENDPOINT`), `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_BUCKET`, `GCS_PROJECT_ID`, `GCS_BUCKET`, `GCS_API_ENDPOINT`, `GCS_KEY_FILE`.

## Gotchas

- **Presigned URLs embed the signing host.** In Docker, set `S3_PUBLIC_ENDPOINT` to the host the
  browser can reach (e.g. `http://localhost:9000`), not `http://rustfs:9000`.
- **The presigned PUT signature covers `content-type`, and `content-length` when you pass
  `contentLength`.** A client that sends another type gets a 403 from S3; this was checked against
  RustFS. Browsers set `content-length` themselves.
- Checksums are `WHEN_REQUIRED`. The SDK's default CRC32 checksums are rejected by many
  S3-compatible stores, and they would break presigned PUTs.
- `PutObject` of a stream with no known length fails, which is why uploads go through lib-storage `Upload`.
  It buffers the stream into `partSize` chunks: one per in-flight part plus the one being filled, so
  each upload holds up to `(queueSize + 1) × partSize` = 3 × 5 MiB ≈ **15 MiB** of off-heap memory
  (outside `--max-old-space-size`). This port does not limit concurrency; callers must (`@app/files`
  caps streamed uploads with `STORAGE_MAX_CONCURRENT_UPLOADS` and answers 503 beyond it). Prefer
  presigned URLs for large or frequent uploads: those bytes never touch the API.
- **GCS:** the real service needs `GCS_API_ENDPOINT=https://storage.googleapis.com`. Any other
  host is treated as an emulator (fake-gcs-server): no auth, and URLs are signed with a throwaway
  RSA key. Signed URLs on GKE need `iam.serviceAccounts.signBlob`
  (`roles/iam.serviceAccountTokenCreator`) or `GCS_KEY_FILE`.
- Keys are authorization boundaries (ownership = `users/{id}/…` prefix). `assertStorageKey` rejects
  `..`, empty segments, leading `/`, control characters and backslashes. Check ownership with
  `isKeyWithinPrefix` (it is not fooled by `users/u10` vs `users/u1`).
- The MinIO images can no longer be pulled. Use `rustfs/rustfs` for local S3.
