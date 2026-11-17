import type { IEvent } from '@nestjs/cqrs';
import { generateId } from '@platform/common';

export interface MembershipCreatedEventProps {
  /** The membership's tenant (the envelope tenant). */
  tenantId: string;
  userId: string;
  /** Normalised (trimmed, lowercase). */
  email: string;
  displayName: string;
  /** Who created it: the member themself (register, login, new tenant, accepted invitation). */
  actorId: string | null;
  occurredAt: Date;
  /** Default: a new uuidv7. */
  eventId?: string;
}

/**
 * A user became a member of a tenant. Raised by the handler that wrote the membership and published
 * only after its unit of work committed; `eventId` becomes the Kafka envelope id.
 */
export class MembershipCreatedEvent implements IEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly actorId: string | null;
  readonly occurredAt: Date;

  constructor(props: MembershipCreatedEventProps) {
    this.eventId = props.eventId ?? generateId();
    this.tenantId = props.tenantId;
    this.userId = props.userId;
    this.email = props.email;
    this.displayName = props.displayName;
    this.actorId = props.actorId;
    this.occurredAt = props.occurredAt;
  }
}
