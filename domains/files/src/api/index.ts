/**
 * @domain/files/api — what an edge app imports: `FilesModule` and its config namespace. Files is
 * edge-only (no core, no persistence); the root entry re-exports this and the services, policies,
 * DTOs and errors for tests and custom wiring.
 */
export { type FilesConfig, filesConfig, filesEnvSchema } from '../files.config.js';
export { FilesModule } from '../files.module.js';
export { FILES_RBAC, FilesPermission } from '../files.permissions.js';
