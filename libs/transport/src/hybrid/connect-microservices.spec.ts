import { grpcConfig, kafkaConfig } from '@app/config';
import {
  type DynamicModule,
  type INestApplication,
  type INestMicroservice,
  type LoggerService,
  Module,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthReportingGrpcServer } from '../grpc/grpc-server.options.js';
import { connectGrpcServer, connectKafkaConsumer } from './connect-microservices.js';

type Connect = (options: unknown, hybrid: unknown) => INestMicroservice;

/**
 * An app whose ConfigService holds `loaded` (namespace → value, as `ConfigModule.forFeature`
 * merges it). Any other `get` records the token and throws, like Nest does on a miss.
 */
function fakeApp(loaded: Record<string, unknown>): {
  app: INestApplication;
  connect: ReturnType<typeof vi.fn<Connect>>;
  missed: unknown[];
} {
  const microservice = {} as INestMicroservice;
  const connect = vi.fn<Connect>(() => microservice);
  const missed: unknown[] = [];
  const configService = { get: (key: string): unknown => loaded[key] };
  const app = {
    get: (token: unknown) => {
      if (token === ConfigService) return configService;
      missed.push(token);
      throw new Error(`Nest could not find ${String(token)} element`);
    },
    connectMicroservice: connect,
  } as unknown as INestApplication;
  return { app, connect, missed };
}

describe('connectGrpcServer', () => {
  it('connects a health-reporting gRPC server from the registered grpc config, inheriting app config', () => {
    const cfg = grpcConfig.parse({ GRPC_URL: '0.0.0.0:7001' });
    const { app, connect } = fakeApp({ [grpcConfig.namespace]: cfg });

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
    const { app, connect, missed } = fakeApp({});
    expect(() => connectGrpcServer(app, ['billing'])).not.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);
    // The namespace token itself is never probed (a miss is what Nest logs at ERROR).
    expect(missed).toEqual([]);
  });
});

describe('connectKafkaConsumer', () => {
  it('connects a Kafka server with the requested consumer group, inheriting app config', () => {
    const cfg = kafkaConfig.parse({ SERVICE_NAME: 'notifications-service' });
    const { app, connect } = fakeApp({ [kafkaConfig.namespace]: cfg });

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
    const { app, connect } = fakeApp({ [kafkaConfig.namespace]: cfg });
    connectKafkaConsumer(app);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      options: { consumer: { groupId: 'notifications-service' } },
    });
  });
});

describe('config resolution on a real Nest application context', () => {
  const errors: string[] = [];
  const logger: LoggerService = {
    log: () => undefined,
    warn: () => undefined,
    error: (message: unknown) => {
      errors.push(String(message));
    },
  };

  afterEach(() => {
    errors.length = 0;
    vi.unstubAllEnvs();
  });

  async function connectKafkaOn(
    imports: (DynamicModule | Promise<DynamicModule>)[],
  ): Promise<unknown> {
    @Module({ imports })
    class TestModule {}
    // A NestFactory instance (unlike `createApplicationContext().init()`'s return value) runs
    // every method in Nest's exception zone, as the apps' `NestFactory.create()` instance does.
    // Never listened on.
    const nest = await NestFactory.createMicroservice(TestModule, {
      transport: Transport.TCP,
      logger,
      abortOnError: false,
    });
    vi.unstubAllEnvs();
    try {
      const connect = vi.fn<Connect>(() => ({}) as INestMicroservice);
      const app = {
        get: (...args: Parameters<INestApplication['get']>): unknown => nest.get(...args),
        connectMicroservice: connect,
      } as unknown as INestApplication;
      connectKafkaConsumer(app);
      return connect.mock.calls[0]?.[0];
    } finally {
      await nest.close();
    }
  }

  it('falls back to the environment without logging "Nest could not find CONFIGURATION(kafka)"', async () => {
    const options = await connectKafkaOn([ConfigModule.forRoot({ ignoreEnvFile: true })]);
    expect(options).toMatchObject({ transport: Transport.KAFKA });
    expect(errors).toEqual([]);
  });

  it('uses the value a module loaded with ConfigModule.forFeature', async () => {
    vi.stubEnv('KAFKA_CLIENT_ID', 'loaded-by-the-container');
    const options = await connectKafkaOn([
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      ConfigModule.forFeature(kafkaConfig),
    ]);
    // The env was reset after the container parsed it: only the container has this client id.
    expect(options).toMatchObject({ options: { client: { clientId: 'loaded-by-the-container' } } });
    expect(errors).toEqual([]);
  });
});
