import { DomainValidationException, isPlatformTenantId, isUuid } from '@platform/common';

/**
 * The tenant a tenant-scoped event is about: the envelope `tenantId`, the only source of a tenant
 * in a consumer. Fails closed: an envelope without one (published before B2-24), a malformed value
 * or the platform (nil) tenant throws, so `@KafkaConsumerController()` dead-letters the record and
 * no row is written, no mail sent.
 * @throws DomainValidationException code EVENT_TENANT_REQUIRED
 */
export function requireEventTenant(event: { tenantId?: string | undefined }): string {
  const { tenantId } = event;
  if (isUuid(tenantId) && !isPlatformTenantId(tenantId)) return tenantId;
  throw new DomainValidationException('Event has no tenant', {
    code: 'EVENT_TENANT_REQUIRED',
    issues: [
      {
        path: 'tenantId',
        message:
          tenantId === undefined
            ? 'A tenant-scoped event must carry the envelope tenantId'
            : 'The envelope tenantId must be a tenant UUID, not the platform tenant',
      },
    ],
  });
}
