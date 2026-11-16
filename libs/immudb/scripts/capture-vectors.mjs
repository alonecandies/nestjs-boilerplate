// Captures proof vectors from a real immudb 1.11.2 for the verification unit specs. Run once (and
// again when the immudb version changes) after building the package:
//   bun run --filter @platform/immudb build && node libs/immudb/scripts/capture-vectors.mjs
// Uses only the generated client (dist), so it needs no Go toolchain and copies no immudb code.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentials, Metadata } from '@grpc/grpc-js';
import { GenericContainer, Wait } from 'testcontainers';
import {
  ImmuServiceClient,
  ImmutableState,
  OpenSessionRequest,
  SQLExecRequest,
  VerifiableSQLEntry,
  VerifiableSQLGetRequest,
  VerifiableTx,
  VerifiableTxRequest,
} from '../dist/generated/immudb/schema/schema.pb.js';

const IMAGE = 'codenotary/immudb:1.11.2';
const OUT = join(import.meta.dirname, '../test/vectors/immudb-1.11.2.json');

const container = await new GenericContainer(IMAGE)
  .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
  .withExposedPorts(3322, 9497)
  .withWaitStrategy(Wait.forHttp('/readyz', 9497))
  .start();
const client = new ImmuServiceClient(
  `${container.getHost()}:${container.getMappedPort(3322)}`,
  credentials.createInsecure(),
);
try {
  const call = (method, request, metadata = new Metadata()) =>
    new Promise((resolve, reject) =>
      client[method](request, metadata, (error, response) =>
        error ? reject(error) : resolve(response),
      ),
    );
  const { sessionID } = await call(
    'openSession',
    OpenSessionRequest.fromPartial({
      username: Buffer.from('immudb'),
      password: Buffer.from('immudb'),
      databaseName: 'defaultdb',
    }),
  );
  const md = () => {
    const metadata = new Metadata();
    metadata.set('sessionid', sessionID);
    return metadata;
  };
  const states = [];
  const snapshot = async () => {
    const state = await call('currentState', {}, md());
    states.push({ txId: state.txId, txHash: state.txHash.toString('base64') });
    return BigInt(state.txId);
  };
  const exec = async (sql) => {
    await call('sqlExec', SQLExecRequest.fromPartial({ sql }), md());
    return snapshot();
  };
  await snapshot();
  await exec('CREATE TABLE vec (id VARCHAR[36], amount INTEGER, note VARCHAR[16], PRIMARY KEY id)');
  const rowTx = {};
  for (let i = 1; i <= 8; i++) {
    rowTx[`row-${i}`] = await exec(
      `INSERT INTO vec (id, amount, note) VALUES ('row-${i}', ${i * 100 - 450}, 'n${i}')`,
    );
  }
  const finalState = ImmutableState.toJSON(await call('currentState', {}, md()));
  const target = BigInt(finalState.txId);
  // states[1] is the CREATE TABLE tx (>= 1). Never prove since tx 0: a fresh database reports tx 0,
  // and VerifiableTxById treats proveSinceTx 0 as "the tx itself" (pkg/database VerifiableTxByID).
  const first = BigInt(states[1].txId);
  const headerOnly = (vt) => ({
    ...vt,
    tx: vt.tx ? { ...vt.tx, entries: [], kvEntries: [], zEntries: [] } : undefined,
  });
  const dualProofs = [];
  for (const source of [target, target - 1n, target - 2n, target - 5n, first]) {
    const vt = await call(
      'verifiableTxById',
      VerifiableTxRequest.fromPartial({ tx: target.toString(), proveSinceTx: source.toString() }),
      md(),
    );
    dualProofs.push({
      sourceTxId: source.toString(),
      targetTxId: target.toString(),
      verifiableTx: VerifiableTx.toJSON(headerOnly(vt)),
    });
  }
  const sqlEntries = [];
  for (const proveSinceTx of [rowTx['row-2'], rowTx['row-3'], target]) {
    const entry = await call(
      'verifiableSqlGet',
      VerifiableSQLGetRequest.fromPartial({
        sqlGetRequest: { table: 'vec', pkValues: [{ value: { $case: 's', value: 'row-3' } }] },
        proveSinceTx: proveSinceTx.toString(),
      }),
      md(),
    );
    sqlEntries.push({
      table: 'vec',
      pk: ['row-3'],
      rowTxId: rowTx['row-3'].toString(),
      proveSinceTx: proveSinceTx.toString(),
      expectedRow: { id: 'row-3', amount: '-150', note: 'n3' },
      verifiableSqlEntry: VerifiableSQLEntry.toJSON({
        ...entry,
        verifiableTx: entry.verifiableTx ? headerOnly(entry.verifiableTx) : undefined,
      }),
    });
  }
  await mkdir(join(import.meta.dirname, '../test/vectors'), { recursive: true });
  await writeFile(
    OUT,
    `${JSON.stringify({ image: IMAGE, states, finalState, dualProofs, sqlEntries }, null, 2)}\n`,
  );
  console.info(`wrote ${OUT}: ${states.length} states, ${dualProofs.length} dual proofs`);
} finally {
  client.close();
  await container.stop();
}
