/**
 * @app/files — the files bounded context (edge-only; no microservice): streamed multipart
 * uploads to S3/GCS, presigned upload/download URLs and deletes, with keys
 * `users/{userId}/{uuidv7}-{safeFilename}` and ownership by key prefix (`files:manage` bypasses).
 * Import `FilesModule` in the gateway and the monolith.
 */
export * from './application/file-access.policy.js';
export * from './application/file-key.js';
export * from './application/files.service.js';
export type * from './application/files.types.js';
export * from './domain/file-content-type.js';
export * from './domain/files.errors.js';
export * from './files.constants.js';
export * from './files.module.js';
export * from './presentation/graphql/create-upload-url.input.js';
export * from './presentation/graphql/files.resolver.js';
export * from './presentation/graphql/presigned-upload.model.js';
export * from './presentation/http/files.controller.js';
export * from './presentation/http/files.dto.js';
export * from './presentation/http/files.response.js';
