/**
 * @platform/storage/testing — the in-memory `StorageService` for specs and e2e apps. Production code
 * reaches it only through `StorageModule.forRootAsync({ driver: 'memory' })`.
 */
export {
  type InMemoryObject,
  type InMemoryStorageOptions,
  InMemoryStorageService,
} from './in-memory-storage.service.js';
