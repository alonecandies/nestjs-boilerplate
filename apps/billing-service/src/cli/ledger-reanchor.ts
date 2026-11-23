import 'reflect-metadata';
import { runLedgerReanchorCli } from '@domain/billing';
import { DATABASE_MIGRATIONS } from '../database.migrations.js';

/*
 * One-off job after an immudb restore: re-anchors billing.ledger_trusted_state with an audit row,
 * then runs one ledger reconciliation over [lost-from, now - 15 min) (the hourly run covers the
 * last 15 minutes).
 * `node dist/cli/ledger-reanchor.js --database <db> --lost-from <ISO time> --operator <name>
 * --reason <text>` in this app's image (docker compose `run`, a k8s Job); without arguments it
 * prints the usage and exits 2. Runbook: docs/OPERATIONS.md (immudb).
 */
await runLedgerReanchorCli({ migrations: DATABASE_MIGRATIONS });
