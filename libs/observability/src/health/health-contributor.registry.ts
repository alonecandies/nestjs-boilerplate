import { Inject, Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { countBy, keys, map, pickBy } from 'lodash-es';
import { HEALTH_OPTIONS } from '../observability.constants.js';
import type { ResolvedHealthOptions } from './health.types.js';
import type { HealthContributor } from './health-contributor.js';

/**
 * Resolves the configured contributor CLASSES to instances once the whole DI graph exists
 * (`onModuleInit`; resolving earlier could hand out half-built instances).
 *
 * Infra libs provide and export their indicator from a global module (e.g. `DatabaseModule` →
 * `DatabaseHealthIndicator`), so the shared instance is reused (`strict: false` searches the whole
 * app). A class nobody provides is instantiated on demand with DI, so listing it is enough.
 */
@Injectable()
export class HealthContributorRegistry implements OnModuleInit {
  private readonly logger = new Logger(HealthContributorRegistry.name);
  private resolved: readonly HealthContributor[] = [];

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(HEALTH_OPTIONS) private readonly options: ResolvedHealthOptions,
  ) {}

  /** Contributors in configuration order (empty before init). */
  get contributors(): readonly HealthContributor[] {
    return this.resolved;
  }

  async onModuleInit(): Promise<void> {
    const contributors = await Promise.all(
      this.options.contributors.map((type) => this.resolve(type)),
    );
    // Terminus merges results by key: a duplicate would silently hide one dependency's state.
    const duplicates = keys(pickBy(countBy(contributors, 'key'), (count) => count > 1));
    if (duplicates.length > 0) {
      throw new Error(`Duplicate health contributor key(s): ${duplicates.join(', ')}`);
    }
    this.resolved = contributors;
    if (contributors.length > 0) {
      this.logger.log(`Readiness contributors: ${map(contributors, 'key').join(', ')}`);
    }
  }

  private async resolve(type: Type<HealthContributor>): Promise<HealthContributor> {
    return this.findProvided(type) ?? this.moduleRef.create(type);
  }

  private findProvided(type: Type<HealthContributor>): HealthContributor | undefined {
    try {
      return this.moduleRef.get<HealthContributor>(type, { strict: false });
    } catch {
      // UnknownElementException: nobody provides it → instantiate on demand.
      return undefined;
    }
  }
}
