import { AppConfigModule, storageConfig } from '@app/config';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageDriver } from './drivers/gcs-storage.driver.js';
import { S3StorageDriver } from './drivers/s3-storage.driver.js';
import {
  createStorageService,
  StorageModule,
  type StorageModuleOptions,
} from './storage.module.js';
import { StorageService } from './storage.service.js';
import { InMemoryStorageService } from './testing/in-memory-storage.service.js';

async function boot(options?: StorageModuleOptions): Promise<INestApplicationContext> {
  @Module({ imports: [AppConfigModule.forRoot(), StorageModule.forRootAsync(options)] })
  class TestModule {}
  return NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false });
}

describe('createStorageService', () => {
  const cfg = storageConfig.parse({});

  it.each([
    ['s3', S3StorageDriver],
    ['gcs', GcsStorageDriver],
    ['memory', InMemoryStorageService],
  ] as const)('builds the %s driver', (driver, type) => {
    const service = createStorageService(cfg, driver);

    expect(service).toBeInstanceOf(type);
    expect(service.driver).toBe(driver);
  });

  it('defaults to STORAGE_DRIVER', () => {
    expect(createStorageService(storageConfig.parse({ STORAGE_DRIVER: 'gcs' }))).toBeInstanceOf(
      GcsStorageDriver,
    );
  });
});

describe('StorageModule', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('binds StorageService to the driver selected by STORAGE_DRIVER (default s3)', async () => {
    const app = await boot();
    try {
      expect(app.get(StorageService)).toBeInstanceOf(S3StorageDriver);
    } finally {
      await app.close();
    }
  });

  it('selects GCS from the environment', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'gcs');
    const app = await boot();
    try {
      expect(app.get(StorageService).driver).toBe('gcs');
    } finally {
      await app.close();
    }
  });

  it('lets tests force the in-memory driver', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'gcs');
    const app = await boot({ driver: 'memory' });
    try {
      expect(app.get(StorageService)).toBeInstanceOf(InMemoryStorageService);
    } finally {
      await app.close();
    }
  });

  it('runs the driver lifecycle hook for the factory-provided instance', async () => {
    const destroy = vi.spyOn(S3StorageDriver.prototype, 'onModuleDestroy');
    const app = await boot();

    await app.close();

    expect(destroy).toHaveBeenCalledOnce();
  });

  it('fails fast on an invalid driver', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'azure');

    await expect(boot()).rejects.toThrow(/STORAGE_DRIVER/);
  });
});
