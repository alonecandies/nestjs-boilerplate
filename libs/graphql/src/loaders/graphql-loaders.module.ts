import { Global, Module } from '@nestjs/common';
import { DataLoaderRegistry } from './data-loader.registry.js';

/**
 * Holds the single `DataLoaderRegistry`. It is a static (non-dynamic) global module, so every
 * importer (the Apollo factory and the domain modules that register loaders) shares one instance.
 */
@Global()
@Module({ providers: [DataLoaderRegistry], exports: [DataLoaderRegistry] })
export class GraphqlLoadersModule {}
