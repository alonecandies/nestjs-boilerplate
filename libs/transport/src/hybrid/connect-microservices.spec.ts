import { grpcConfig, kafkaConfig } from '@app/config';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';
import { HealthReportingGrpcServer } from '../grpc/grpc-server.options.js';
import { connectGrpcServer, connectKafkaConsumer } from './connect-microservices.js';

type Connect = (options: unknown, hybrid: unknown) => INestMicroservice;

function fakeApp(registered: Record<string, unknown>): {
  app: INestApplication;
  connect: ReturnType<typeof vi.fn<Connect>>;
} {
  const microservice = {} as INestMicroservice;
  const connect = vi.fn<Connect>(() => microservice);
  const app = {
    get: (token: string) => {
      if (token in registered) return registered[token];
      throw new Error(`Nest could not find ${token} element`);
    },
    connectMicroservice: connect,
  } as unknown as INestApplication;
  return { app, connect };
}

describe('connectGrpcServer', () => {
  it('connects a health-reporting gRPC server from the registered grpc config, inheriting app config', () => {
    const cfg = grpcConfig.parse({ GRPC_URL: '0.0.0.0:7001' });
    const { app, connect } = fakeApp({ [grpcConfig.KEY]: cfg });

    connectGrpcServer(app, ['identity']);

    expect(connect).toHaveBeenCalledTimes(1);
    const [options, hybrid] = connect.mock.calls[0] ?? [];
    expect(hybrid).toEqual({ inheritAppConfig: true });
    const { strategy } = options as { strategy: HealthReportingGrpcServer };
    expect(strategy).toBeInstanceOf(HealthReportingGrpcServer);
    expect(strategy.health.services).toEqual([
      'identity.v1.AuthService',
      'identity.v1.UsersService',
    ]);
  });

  it('falls back to parsing the environment when no module loaded the namespace', () => {
    const { app, connect } = fakeApp({});
    expect(() => connectGrpcServer(app, ['billing'])).not.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('connectKafkaConsumer', () => {
  it('connects a Kafka server with the requested consumer group, inheriting app config', () => {
    const cfg = kafkaConfig.parse({ SERVICE_NAME: 'notifications-service' });
    const { app, connect } = fakeApp({ [kafkaConfig.KEY]: cfg });

    connectKafkaConsumer(app, { groupId: 'gateway-push' });

    const [options, hybrid] = connect.mock.calls[0] ?? [];
    expect(hybrid).toEqual({ inheritAppConfig: true });
    expect(options).toMatchObject({
      transport: Transport.KAFKA,
      options: {
        postfixId: '',
        client: { clientId: 'notifications-service' },
        consumer: { groupId: 'gateway-push' },
      },
    });
  });

  it('defaults the consumer group to kafkaConfig.groupId', () => {
    const cfg = kafkaConfig.parse({ SERVICE_NAME: 'notifications-service' });
    const { app, connect } = fakeApp({ [kafkaConfig.KEY]: cfg });
    connectKafkaConsumer(app);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      options: { consumer: { groupId: 'notifications-service' } },
    });
  });
});
