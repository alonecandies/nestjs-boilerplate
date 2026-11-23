// Replays a dead-letter topic into its source topic from a checkout, once the cause of the failures
// is fixed:
//   bun run build   # the script runs the compiled packages (dist/), like the production image
//   node --env-file=.env libs/transport/scripts/kafka-dlq-replay.mjs <topic> [--dry-run] [--group <id>]
// A thin wrapper of `runDlqReplayCli` (libs/transport/src/kafka/dlq-replay-cli.ts), the same body
// as `node dist/cli/dlq-replay.js` in the image of every app that consumes Kafka: <topic> is the
// SOURCE topic and `<topic>.dlq` is read; progress is committed to the group (default
// `<topic>.dlq-replay`). Exit codes: 0 replayed, 1 skipped or failed, 2 usage.
import 'reflect-metadata';
import { runDlqReplayCli } from '../dist/index.js';

await runDlqReplayCli();
