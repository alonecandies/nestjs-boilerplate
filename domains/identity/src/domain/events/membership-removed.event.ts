import type { IEvent } from '@nestjs/cqrs';
import { generateId } from '@platform/common';

export interface MembershipRemovedEventProps {
  /** The membership's tenant (the envelope tenant). */
  tenantId: string;
  userId: string;
  /** Who ended it: the remover, or the member who left. */
  actorId: string | null;
  occurredAt: Date;
  /** Default: a new uuidv7. */
  eventId?: string;
}

/**
 * A user stopped being a member of a tenant (removed, or left). Published only after the handler's
 * unit of work committed; `eventId` becomes the Kafka envelope id.
 */
export class MembershipRemovedEvent implements IEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly actorId: string | null;
  readonly occurredAt: Date;

  constructor(props: MembershipRemovedEventProps) {
    this.eventId = props.eventId ?? generateId();
    this.tenantId = props.tenantId;
    this.userId = props.userId;
    this.actorId = props.actorId;
    this.occurredAt = props.occurredAt;
  }
}
