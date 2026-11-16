/**
 * Setup file of every Vitest project, loaded after `reflect-metadata` (see SETUP_FILES in
 * vitest.config.ts). Specs that exercise failure paths make Nest log WARN/ERROR lines with stack
 * traces; silencing Nest keeps the test output readable. Specs that assert on logging spy on
 * `Logger.prototype` methods, which still run. Set TEST_LOGS=1 to print the logs.
 */
import { Logger } from '@nestjs/common';
// Not re-exported by the package index; its "./*.js" export maps this path.
import { TestingLogger } from '@nestjs/testing/services/testing-logger.service.js';

export type NestTestLogging = 'silent' | 'verbose';

export function configureNestTestLogging(env: NodeJS.ProcessEnv = process.env): NestTestLogging {
  if (env.TEST_LOGS === '1') return 'verbose';
  // `new Logger(ctx)` delegates to the static logger: without one, nothing prints.
  Logger.overrideLogger(false);
  // `Test.createTestingModule().compile()` installs a TestingLogger, which still prints errors.
  TestingLogger.prototype.error = () => undefined;
  return 'silent';
}

configureNestTestLogging();
