import type { PaymentList } from '@domain/billing-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { hasPermissions, principalPermissions, RbacRegistry } from '@platform/auth';
import { type CursorPage, PermissionDeniedException, resolvePageSize } from '@platform/common';
import { RlsElevation, Transactional } from '@platform/database';
import { BILLING_LIMITS } from '../../../billing.constants.js';
import { BillingPermission } from '../../../billing.permissions.js';
import type { Payment } from '../../../domain/payment.aggregate.js';
import { toPaymentListContract } from '../../mappers/payment.mapper.js';
import {
  type ListPaymentsCriteria,
  PaymentsRepository,
} from '../../repositories/payments.repository.js';
import { requireTenantPrincipal } from '../../tenant-scope.js';
import { ListPaymentsQuery } from './list-payments.query.js';

/**
 * Keyset-paginated, index-backed listing: `WHERE tenant_id = $1 [AND user_id = $2] [AND id < $cursor] ORDER BY id DESC
 * LIMIT n + 1` (one query; the look-ahead row decides whether `nextCursor` is set).
 *
 * Runs as the request principal (B3-13). The `payments` policy shows a user only their own rows;
 * the whole tenant (`billing:read-all`) needs `elevate(billing:read-all)` first in the same unit
 * of work, which re-checks the permission and never crosses the tenant.
 */
@QueryHandler(ListPaymentsQuery)
export class ListPaymentsHandler implements IQueryHandler<ListPaymentsQuery> {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly elevation: RlsElevation,
    private readonly rbac: RbacRegistry,
  ) {}

  async execute({ criteria }: ListPaymentsQuery): Promise<PaymentList> {
    const principal = requireTenantPrincipal(criteria.tenantId, criteria.userId);
    const wholeTenant = criteria.userId === undefined;
    // Service-side recomputation (spec §7): the roles travelled, the permissions are ours. Refused
    // here, before any unit of work opens.
    if (
      wholeTenant &&
      !hasPermissions(principalPermissions(this.rbac, principal), [BillingPermission.ReadAll])
    ) {
      throw new PermissionDeniedException(
        'Listing every payment of a workspace requires billing:read-all',
        { details: { required: [BillingPermission.ReadAll] } },
      );
    }
    // 0 / absent = default (proto3 ints decode as 0); anything else is capped at MAX.
    const limit = resolvePageSize(criteria.limit, {
      defaultSize: BILLING_LIMITS.DEFAULT_PAGE_SIZE,
      maxSize: BILLING_LIMITS.MAX_PAGE_SIZE,
    });
    const page = await this.read(
      { tenantId: criteria.tenantId, userId: criteria.userId, limit, cursor: criteria.cursor },
      wholeTenant,
    );
    return toPaymentListContract(page);
  }

  /** One unit of work as the request principal; elevated first for the whole tenant. */
  @Transactional()
  protected async read(
    criteria: ListPaymentsCriteria,
    wholeTenant: boolean,
  ): Promise<CursorPage<Payment>> {
    if (wholeTenant) await this.elevation.elevate(BillingPermission.ReadAll);
    return this.payments.list(criteria);
  }
}
