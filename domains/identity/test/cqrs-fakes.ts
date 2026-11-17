import { type EventBus, EventPublisher, type IEvent } from '@nestjs/cqrs';
import { vi } from 'vitest';

/** A recording EventBus: `published` holds every event published through it, in order. */
export function recordingEventBus(): { eventBus: EventBus; published: IEvent[] } {
  const published: IEvent[] = [];
  const eventBus = {
    publish: vi.fn((event: IEvent) => {
      published.push(event);
    }),
    publishAll: vi.fn((events: IEvent[]) => {
      published.push(...events);
    }),
  };
  return { eventBus: eventBus as unknown as EventBus, published };
}

/**
 * A real `EventPublisher` over a recording EventBus: `published` holds committed events and the
 * events handlers publish on `eventBus` directly, in order.
 */
export function recordingPublisher(): {
  publisher: EventPublisher;
  eventBus: EventBus;
  published: IEvent[];
} {
  const { eventBus, published } = recordingEventBus();
  return { publisher: new EventPublisher(eventBus), eventBus, published };
}
