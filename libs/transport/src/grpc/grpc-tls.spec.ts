import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChannelCredentials, credentials } from '@grpc/grpc-js';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { generateId } from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { ClsModule } from 'nestjs-cls';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_GRPC_PACKAGE,
  type GetUserRequest,
  type GetUsersByIdsRequest,
  type ListUsersRequest,
  type UpdateUserRolesRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceClient,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '../../test/fixtures/fixture.grpc-package.js';
import { withBoundGrpcPort } from '../testing/bound-grpc-port.js';
import { createGrpcClientOptions } from './grpc-client.options.js';
import { GrpcController } from './grpc-controller.decorator.js';
import { createGrpcServerStrategy } from './grpc-server.options.js';

/** Real mutual TLS over loopback with throwaway certificates (needs the `openssl` CLI). */

const USER: User = {
  id: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  roles: ['user'],
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
  updatedAt: new Date('2026-01-02T03:04:05.678Z'),
};

@GrpcController()
@UsersServiceControllerMethods()
class TlsUsersGrpcController implements UsersServiceController {
  getUser(_request: GetUserRequest): User {
    return USER;
  }
  getUsersByIds(_request: GetUsersByIdsRequest): UserList {
    return { users: [] };
  }
  listUsers(_request: ListUsersRequest): UserPage {
    return { items: [] };
  }
  updateUserRoles(_request: UpdateUserRolesRequest): User {
    return USER;
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [TlsUsersGrpcController],
})
class TlsGrpcModule {}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A CA plus a server (localhost) and a client certificate it signed. */
function issueCertificates(dir: string): Record<'ca' | 'cert' | 'key' | 'otherCa', string> {
  const run = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  };
  const ca = (name: string): void =>
    run(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.pem`,
    );
  ca('ca');
  ca('other-ca');
  writeFileSync(
    join(dir, 'ext.cnf'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n',
  );
  run(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    'svc.key',
    '-out',
    'svc.csr',
  );
  run(
    'x509',
    '-req',
    '-in',
    'svc.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    'ext.cnf',
    '-out',
    'svc.pem',
  );
  return {
    ca: join(dir, 'ca.pem'),
    cert: join(dir, 'svc.pem'),
    key: join(dir, 'svc.key'),
    otherCa: join(dir, 'other-ca.pem'),
  };
}

describe.skipIf(!hasOpenssl())('gRPC mutual TLS (in-process server)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grpc-mtls-'));
  let files: ReturnType<typeof issueCertificates>;
  let port = 0; // the server binds an OS-chosen port; read back once it is up
  let app: INestMicroservice;
  const clients: ClientGrpcProxy[] = [];

  const config = (env: Record<string, string>): GrpcConfig =>
    grpcConfig.parse({
      NODE_ENV: 'test',
      GRPC_URL: `127.0.0.1:${port}`,
      GRPC_DEADLINE_MS: '3000',
      ...env,
    });

  function getUser(cfg: GrpcConfig, override?: ChannelCredentials): Promise<User> {
    // `localhost` (not the IP): the throwaway server certificate is issued for that name.
    const target = { spec: FIXTURE_GRPC_PACKAGE, url: `localhost:${port}` };
    const options = createGrpcClientOptions(cfg, target, { maxAttempts: 1 }).options;
    const client = new ClientGrpcProxy(
      override === undefined ? options : { ...options, credentials: override },
    );
    clients.push(client);
    return lastValueFrom(
      client.getService<UsersServiceClient>('UsersService').getUser({ id: '1' }),
    );
  }

  beforeAll(async () => {
    files = issueCertificates(dir);
    const serverCfg = config({
      GRPC_TLS_CA_PATH: files.ca,
      GRPC_TLS_CERT_PATH: files.cert,
      GRPC_TLS_KEY_PATH: files.key,
    });
    ({ port } = await withBoundGrpcPort(async () => {
      app = await NestFactory.createMicroservice(TlsGrpcModule, {
        ...createGrpcServerStrategy(serverCfg, [FIXTURE_GRPC_PACKAGE]),
        logger: false,
      });
      await app.listen();
    }));
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a client that presents a certificate signed by the CA', async () => {
    const user = await getUser(
      config({
        GRPC_TLS_CA_PATH: files.ca,
        GRPC_TLS_CERT_PATH: files.cert,
        GRPC_TLS_KEY_PATH: files.key,
      }),
    );
    expect(user.id).toBe(USER.id);
  });

  it('rejects a plaintext client', async () => {
    await expect(getUser(config({}))).rejects.toMatchObject({ code: 14 });
  });

  it('rejects a TLS client that presents no certificate (mutual TLS)', async () => {
    await expect(
      getUser(config({}), credentials.createSsl(readFileSync(files.ca))),
    ).rejects.toMatchObject({ code: 14 });
  });

  it('refuses a server whose certificate another CA signed', async () => {
    await expect(
      getUser(
        config({
          GRPC_TLS_CA_PATH: files.otherCa,
          GRPC_TLS_CERT_PATH: files.cert,
          GRPC_TLS_KEY_PATH: files.key,
        }),
      ),
    ).rejects.toMatchObject({ code: 14 });
  });
});
