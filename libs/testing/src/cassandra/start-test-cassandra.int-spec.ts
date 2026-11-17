import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cassandra from 'cassandra-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestCassandra,
  TEST_CASSANDRA_IMAGE,
  type TestCassandra,
} from './start-test-cassandra.js';

/*
 * The Cassandra test container itself. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project testing:int src/cassandra
 */

const COMPOSE_FILE = join(import.meta.dirname, '../../../../docker-compose.yml');

describe('TEST_CASSANDRA_IMAGE', () => {
  it('is the image of the compose cassandra service', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const service = /^ {2}cassandra:\n {4}image: (\S+)$/m.exec(compose);
    expect(service?.[1]).toBe(TEST_CASSANDRA_IMAGE);
  });
});

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  `startTestCassandra on ${TEST_CASSANDRA_IMAGE}`,
  () => {
    let node: TestCassandra | undefined;
    let client: cassandra.Client | undefined;

    beforeAll(async () => {
      node = await startTestCassandra({ keyspace: 'probe_ks' });
      client = new cassandra.Client({
        contactPoints: node.contactPoints,
        localDataCenter: node.localDataCenter,
      });
      await client.connect();
    });

    afterAll(async () => {
      await client?.shutdown();
      await node?.stop();
    });

    it('created the requested keyspace with replication factor 1', async () => {
      expect(node?.keyspace).toBe('probe_ks');
      const rs = await client!.execute(
        'SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = ?',
        ['probe_ks'],
        { prepare: true },
      );
      expect(rs.rows).toHaveLength(1);
      expect(rs.rows[0]?.get('replication')).toMatchObject({ replication_factor: '1' });
    });

    it('a client bound to the keyspace reads and writes through the mapped port', async () => {
      const bound = new cassandra.Client({
        contactPoints: node!.contactPoints,
        localDataCenter: node!.localDataCenter,
        keyspace: node!.keyspace,
      });
      try {
        await bound.execute('CREATE TABLE IF NOT EXISTS probe (id int PRIMARY KEY, label text)');
        await bound.execute('INSERT INTO probe (id, label) VALUES (?, ?)', [1, 'one'], {
          prepare: true,
        });
        const rs = await bound.execute('SELECT label FROM probe WHERE id = ?', [1], {
          prepare: true,
        });
        expect(rs.rows[0]?.get('label')).toBe('one');
      } finally {
        await bound.shutdown();
      }
    });

    it('stop() is safe to call twice', async () => {
      await client?.shutdown();
      client = undefined;
      await node?.stop();
      await expect(node?.stop()).resolves.toBeUndefined();
    });
  },
);
