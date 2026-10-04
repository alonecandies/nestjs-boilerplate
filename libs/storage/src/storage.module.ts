import { type StorageConfig, storageConfig } from '@app/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GcsStorageDriver } from './drivers/gcs-storage.driver.js';
import { S3StorageDriver } from './drivers/s3-storage.driver.js';
import { StorageService } from './storage.service.js';
import type { StorageDriverName } from './storage.types.js';
import { InMemoryStorageService } from './testing/in-memory-storage.service.js';

export interface StorageModuleOptions {
  /**
   * Overrides `STORAGE_DRIVER`. `'memory'` binds `InMemoryStorageService` (e2e tests, demos
   * without an object store). Leave unset in real apps so deployments choose by env.
   */
  driver?: StorageDriverName;
}

/**
 * Instantiates the driver for `driver` (default: `STORAGE_DRIVER`). Exported so scripts and tests
 * can build the same `StorageService` without a Nest container.
 */
export function createStorageService(
  cfg: StorageConfig,
  driver: StorageDriverName = cfg.driver,
): StorageService {
  switch (driver) {
    case 's3':
      return new S3StorageDriver(cfg);
    case 'gcs':
      return new GcsStorageDriver(cfg);
    case 'memory':
      return new InMemoryStorageService({ signedUrlTtlSec: cfg.signedUrlTtlSec });
  }
}

/**
 * Global object storage: binds the abstract `StorageService` token to the S3 or GCS driver chosen
 * by `STORAGE_DRIVER`, so consumers never depend on a vendor SDK. It is a factory provider, not
 * `useClass`: only the selected driver's client is built (no GCS key generation in an S3
 * deployment), and Nest still runs its `onModuleDestroy` (the S3 driver closes its keep-alive
 * sockets there).
 */
@Module({})
export class StorageModule {
  static forRootAsync(options: StorageModuleOptions = {}): DynamicModule {
    return {
      module: StorageModule,
      global: true,
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [
        {
          provide: StorageService,
          inject: [storageConfig.KEY],
          useFactory: (cfg: StorageConfig): StorageService =>
            createStorageService(cfg, options.driver),
        },
      ],
      exports: [StorageService],
    };
  }
}
