import { KafkaContext } from '@nestjs/microservices';

/*
 * Class checks that survive duplicated package copies ("realms").
 *
 * Bun's isolated linker installs one copy of a package per distinct peer set. Today that gives two
 * copies of `@nestjs/microservices`: this package imports `…+dc877a02…`, while the `@nestjs/core`
 * every app runs links `…+ab13e63f…`. `app.connectMicroservice()` loads the transport strategies
 * through `@nestjs/core`, so the `KafkaContext` a handler receives, and any `RpcException` Nest
 * itself throws, belong to the OTHER copy. A plain `instanceof` against our import is then false in
 * every app, which silently disabled dead-lettering (a poison message was redelivered forever) and
 * the Kafka CLS context, and turned Nest's RpcExceptions into INTERNAL.
 *
 * These guards accept an instance of either copy: `instanceof` first (the fast, common path in a
 * deduplicated install), then a structural or class-name match.
 */

/** The `KafkaContext` methods this package calls (dead-lettering and the CLS interceptor). */
const KAFKA_CONTEXT_METHODS = ['getTopic', 'getPartition', 'getMessage', 'getProducer'] as const;

/** A `KafkaContext` of ANY `@nestjs/microservices` copy. */
export function isKafkaContext(value: unknown): value is KafkaContext {
  if (value instanceof KafkaContext) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return KAFKA_CONTEXT_METHODS.every((method) => typeof candidate[method] === 'function');
}

/**
 * `value instanceof ctor` across copies: true when `ctor` or a class named `className` is on
 * `value`'s prototype chain (subclasses included). `className` is passed explicitly rather than
 * read from `ctor.name`, so the check does not depend on how the dependency was built.
 */
export function isInstanceAcrossRealms<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
  className: string,
): value is T {
  if (value instanceof ctor) return true;
  if (typeof value !== 'object' || value === null) return false;
  for (
    let proto: unknown = Object.getPrototypeOf(value);
    proto !== null && proto !== undefined;
    proto = Object.getPrototypeOf(proto)
  ) {
    const ctorOfProto: unknown = (proto as { constructor?: unknown }).constructor;
    if (typeof ctorOfProto === 'function' && ctorOfProto.name === className) return true;
  }
  return false;
}
