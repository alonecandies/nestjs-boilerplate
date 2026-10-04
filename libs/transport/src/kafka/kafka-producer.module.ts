import { type AppConfig, appConfig, type KafkaConfig, kafkaConfig } from '@app/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, type KafkaOptions } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import { KAFKA_PRODUCER_CLIENT, KAFKA_PRODUCER_OPTIONS } from './kafka.constants.js';
import { KafkaHealthIndicator } from './kafka.health.js';
import { createKafkaClientOptions } from './kafka.options.js';
import { KafkaProducer, type KafkaProducerOptions } from './kafka-producer.service.js';

export interface KafkaProducerModuleOptions {
  /** Envelope `source`. Default `appConfig.serviceName`. */
  source?: string;
  /** See `KafkaProducerOptions.eagerConnect`. Default `true`. */
  eagerConnect?: boolean;
  /** See `KafkaProducerOptions.connectRetry`. */
  connectRetry?: KafkaProducerOptions['connectRetry'];
}

/**
 * Global module with the producer-only `ClientKafka` (`KAFKA_PRODUCER_CLIENT`), `KafkaProducer`
 * and `KafkaHealthIndicator`. Import it once in the root module of every process that publishes
 * events. It also exports the `kafka` config namespace, so `KafkaHealthIndicator` resolves
 * wherever `ObservabilityModule` instantiates it.
 *
 * The client is closed by `ClientsModule` in `onApplicationShutdown`, after servers stopped
 * consuming, so events produced by in-flight handlers are still flushed.
 */
@Module({})
export class KafkaProducerModule {
  static forRootAsync(options: KafkaProducerModuleOptions = {}): DynamicModule {
    const kafkaConfigModule = ConfigModule.forFeature(kafkaConfig);
    const appConfigModule = ConfigModule.forFeature(appConfig);
    const clients = ClientsModule.registerAsync([
      {
        name: KAFKA_PRODUCER_CLIENT,
        imports: [kafkaConfigModule],
        inject: [kafkaConfig.KEY],
        useFactory: (cfg: KafkaConfig): KafkaOptions => createKafkaClientOptions(cfg),
      },
    ]);
    return {
      module: KafkaProducerModule,
      global: true,
      // TerminusModule supplies HealthIndicatorService for KafkaHealthIndicator.
      imports: [kafkaConfigModule, appConfigModule, clients, TerminusModule],
      providers: [
        {
          provide: KAFKA_PRODUCER_OPTIONS,
          inject: [appConfig.KEY],
          useFactory: (app: AppConfig): KafkaProducerOptions => ({
            source: options.source ?? app.serviceName,
            eagerConnect: options.eagerConnect ?? true,
            connectRetry: options.connectRetry,
          }),
        },
        KafkaProducer,
        KafkaHealthIndicator,
      ],
      exports: [
        clients,
        kafkaConfigModule,
        KAFKA_PRODUCER_OPTIONS,
        KafkaProducer,
        KafkaHealthIndicator,
      ],
    };
  }
}
