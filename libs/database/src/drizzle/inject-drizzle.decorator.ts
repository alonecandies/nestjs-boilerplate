import { Inject } from '@nestjs/common';
import { DRIZZLE } from './drizzle.constants.js';

/**
 * `constructor(@InjectDrizzle() private readonly db: DrizzleDB<typeof schema>) {}`
 *
 * The explicit token is required: `DrizzleDB` is a type alias, so constructor-type DI has nothing
 * to resolve (import `DrizzleDB` with `import type`).
 */
export const InjectDrizzle = (): PropertyDecorator & ParameterDecorator => Inject(DRIZZLE);
