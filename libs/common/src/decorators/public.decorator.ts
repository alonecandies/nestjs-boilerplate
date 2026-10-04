import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants/metadata.constants.js';

/**
 * Marks a route (or a whole controller/resolver) as public: the global `JwtAuthGuard` lets it
 * through without a token, and ops endpoints use it to bypass auth-aware throttling.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
