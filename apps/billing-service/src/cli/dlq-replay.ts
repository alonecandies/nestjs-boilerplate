import 'reflect-metadata';
import { runDlqReplayCli } from '@platform/transport';

/*
 * One-off job: replays `<topic>.dlq` into `<topic>` once the cause of the dead letters is fixed.
 * `node dist/cli/dlq-replay.js <topic> [--dry-run] [--group <id>]` in this app's image (docker
 * compose `run`, a k8s Job); without arguments it prints the usage and exits 2. Runbook:
 * docs/OBSERVABILITY.md (dead letters).
 */
await runDlqReplayCli();
