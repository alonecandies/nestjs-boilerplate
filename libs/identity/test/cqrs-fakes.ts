import { type EventBus, EventPublisher, type IEvent } from '@nestjs/cqrs';
import { vi } from 'vitest';

/** A real `EventPublisher` over a recording EventBus: `published` holds committed events. */
export function recordingPublisher(): { publisher: EventPublisher; published: IEvent[] } {
  const published: IEvent[] = [];
  const eventBus = {
    publish: vi.fn((event: IEvent) => {
      published.push(event);
    }),
    publishAll: vi.fn((events: IEvent[]) => {
      published.push(...events);
    }),
  };
  return { publisher: new EventPublisher(eventBus as unknown as EventBus), published };
}
