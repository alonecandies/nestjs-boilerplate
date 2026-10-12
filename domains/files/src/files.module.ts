import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MultipartModule, type MultipartModuleOptions } from '@nestjs/platform-fastify/multipart';
import { FilesService } from './application/files.service.js';
import { type FilesConfig, filesConfig } from './files.config.js';
import { FilesResolver } from './presentation/graphql/files.resolver.js';
import { FilesController } from './presentation/http/files.controller.js';

/**
 * The files bounded context (edge-only: gateway and monolith import it as-is; there is no files
 * service). REST `/v1/files` + GraphQL `createUploadUrl`, both backed by `FilesService`.
 *
 * Expects from the app (all global): `AppConfigModule.forRoot()`, `StorageModule.forRootAsync()`,
 * `AuthModule.forRootAsync()` (guards) and `provideCommonEnhancers*()` (validation pipes +
 * problem+json filter). `AppGraphqlModule` is optional (the resolver is simply not served
 * without it). The Fastify adapter registers `@fastify/multipart` on first use.
 */
@Module({
  imports: [
    // The files context's own namespace (upload limits); storage settings belong to StorageModule.
    ConfigModule.forFeature(filesConfig),
    // Module-wide default of every upload interceptor declared in this module: the per-file
    // byte limit comes from config (a decorator argument can't read it).
    MultipartModule.registerAsync({
      imports: [ConfigModule.forFeature(filesConfig)],
      inject: [filesConfig.KEY],
      useFactory: (cfg: FilesConfig): MultipartModuleOptions => ({
        limits: { fileSize: cfg.maxUploadBytes },
      }),
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService, FilesResolver],
  exports: [FilesService],
})
export class FilesModule {}
