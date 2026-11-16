import type { INestApplicationContext } from '@nestjs/common';
import { MetricsListener } from '@platform/observability';

/**
 * Opens the app's metrics listener on `METRICS_PORT` (default 9464), apart from the API port. Call
 * it in `main.ts` right before `listen(app)`. Resolves the listener URL, or `undefined` when metrics
 * are disabled or in a cluster worker (the primary serves the aggregate). Throws when the port is
 * taken or equals `PORT`.
 */
export function listenMetrics(app: INestApplicationContext): Promise<string | undefined> {
  return app.get(MetricsListener, { strict: false }).start();
}
