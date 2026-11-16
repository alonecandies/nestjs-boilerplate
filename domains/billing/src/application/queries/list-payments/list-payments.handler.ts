import type { PaymentList } from '@domain/billing-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { hasPermissions, principalPermissions, RbacRegistry } from '@platform/auth';
import { PermissionDeniedException } from '@platform/common';
import { clamp, isInteger } from 'lodash-es';
import { BILLING_LIMITS } from '../../../billing.constants.js';
import { BillingPermission } from '../../../billing.permissions.js';
import { toPaymentListContract } from '../../mappers/payment.mapper.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { requireTenantPrincipal } from '../../tenant-scope.js';
import { ListPaymentsQuery } from './list-payments.query.js';

/**
 * Keyset-paginated, index-backed listing: `WHERE tenant_id = $1 [AND user_id = $2] [AND id < $cursor] ORDER BY id DESC
 * LIMIT n + 1` (one query; the look-ahead row decides whether `nextCursor` is set).
 */
@QueryHandler(ListPaymentsQuery)
export class ListPaymentsHandler implements IQueryHandler<ListPaymentsQuery> {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly rbac: RbacRegistry,
  ) {}

  async execute({ criteria }: ListPaymentsQuery): Promise<PaymentList> {
    const principal = requireTenantPrincipal(criteria.tenantId, criteria.userId);
    // Service-side recomputation (spec §7): the roles travelled, the permissions are ours.
    if (
      criteria.userId === undefined &&
      !hasPermissions(principalPermissions(this.rbac, principal), [BillingPermission.ReadAll])
    ) {
      throw new PermissionDeniedException(
        'Listing every payment of a workspace requires billing:read-all',
        { details: { required: [BillingPermission.ReadAll] } },
      );
    }
    // 0 / absent = default (proto3 ints decode as 0); anything else is capped at MAX.
    const requested = criteria.limit ?? 0;
    const limit =
      isInteger(requested) && requested > 0
        ? clamp(requested, 1, BILLING_LIMITS.MAX_PAGE_SIZE)
        : BILLING_LIMITS.DEFAULT_PAGE_SIZE;
    const page = await this.payments.list({
      tenantId: criteria.tenantId,
      userId: criteria.userId,
      limit,
      cursor: criteria.cursor,
    });
    return toPaymentListContract(page);
  }
}
