import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import { isFunction } from 'lodash-es';
import { HTTP_HEADERS, PROBLEM_JSON_CONTENT_TYPE } from '../constants/headers.constants.js';
import { MAINTENANCE_MODE, MAINTENANCE_MODE_OPTIONS } from '../constants/tokens.constants.js';
import { getHeaderValue } from '../context/execution-context.util.js';
import { ServiceUnavailableException } from '../errors/domain.exception.js';
import { toProblemDetails } from '../errors/problem-details.js';
import {
  type NextFunction,
  type RawRequest,
  type RawResponse,
  requestPath,
} from './raw-http.types.js';

/** `boolean` for a boot-time switch, or a function for runtime toggles (feature flag, admin API). */
export type MaintenanceModeSwitch = boolean | (() => boolean);

export interface MaintenanceModeOptions {
  /** `Retry-After` seconds sent with the 503. Default 120. */
  retryAfterSec: number;
  /**
   * Paths that keep working during maintenance (probes must stay green or the orchestrator
   * restarts healthy pods). A trailing `*` means prefix match. Default `['/health*', '/metrics']`.
   */
  bypassPaths: readonly string[];
}

export const DEFAULT_MAINTENANCE_MODE_OPTIONS: Readonly<MaintenanceModeOptions> = {
  retryAfterSec: 120,
  bypassPaths: ['/health*', '/metrics'],
};

const MAINTENANCE_DETAIL = 'The service is undergoing maintenance. Please retry later.';

/**
 * Short-circuits every request with `503` problem+json + `Retry-After` while maintenance mode is
 * on, except health/metrics. Written directly to the raw response: on Fastify, Nest middleware
 * only sees the Node objects (see `RawRequest`).
 */
@Injectable()
export class MaintenanceModeMiddleware implements NestMiddleware<RawRequest, RawResponse> {
  private readonly options: MaintenanceModeOptions;
  private readonly exactBypass: ReadonlySet<string>;
  private readonly prefixBypass: readonly string[];

  constructor(
    @Optional() @Inject(MAINTENANCE_MODE) private readonly maintenanceMode?: MaintenanceModeSwitch,
    @Optional() @Inject(MAINTENANCE_MODE_OPTIONS) options?: Partial<MaintenanceModeOptions>,
  ) {
    this.options = { ...DEFAULT_MAINTENANCE_MODE_OPTIONS, ...options };
    // Pre-split once: this runs on every request.
    const prefixes = this.options.bypassPaths.filter((p) => p.endsWith('*'));
    this.prefixBypass = prefixes.map((p) => p.slice(0, -1));
    this.exactBypass = new Set(this.options.bypassPaths.filter((p) => !p.endsWith('*')));
  }

  use(req: RawRequest, res: RawResponse, next: NextFunction): void {
    const path = this.isEnabled() ? requestPath(req) : undefined;
    if (path === undefined || this.isBypassed(path)) {
      next();
      return;
    }

    const requestId =
      req.id === undefined ? getHeaderValue(req.headers, HTTP_HEADERS.REQUEST_ID) : String(req.id);
    const problem = toProblemDetails(new ServiceUnavailableException(MAINTENANCE_DETAIL), {
      requestId,
      instance: path,
      exposeInternal: false,
    });
    res.statusCode = problem.status;
    res.setHeader('content-type', PROBLEM_JSON_CONTENT_TYPE);
    res.setHeader('cache-control', 'no-store');
    res.setHeader(HTTP_HEADERS.RETRY_AFTER, String(this.options.retryAfterSec));
    res.end(JSON.stringify(problem));
  }

  private isEnabled(): boolean {
    const mode = this.maintenanceMode;
    return isFunction(mode) ? mode() : mode === true;
  }

  private isBypassed(path: string): boolean {
    return (
      this.exactBypass.has(path) || this.prefixBypass.some((prefix) => path.startsWith(prefix))
    );
  }
}
