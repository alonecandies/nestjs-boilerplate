/**
 * @app/storage — driver-agnostic object storage. Inject the abstract `StorageService`.
 * `StorageModule` binds it to the S3 (RustFS/MinIO/R2/AWS) or GCS driver chosen by
 * `STORAGE_DRIVER`: streaming uploads, presigned PUT/GET URLs on the public endpoint, HEAD, DELETE.
 * `InMemoryStorageService` is the test double.
 */
export * from './drivers/gcs-storage.driver.js';
export * from './drivers/s3-storage.driver.js';
export * from './storage.errors.js';
export * from './storage.module.js';
export * from './storage.service.js';
export * from './storage.types.js';
export * from './storage-key.util.js';
export * from './testing/in-memory-storage.service.js';
