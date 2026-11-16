import { Test } from '@nestjs/testing';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { EntityNotFoundException, provideCommonEnhancers } from '@platform/common';
import { createFastifyTestApp, createMock } from '@platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_TEST_IMPORTS,
  bearer,
  principal,
  type TestPrincipal,
} from '../../../test/auth-test.module.js';
import { AuthPort } from '../../application/ports/auth.port.js';
import { NotPlatformStaffException } from '../../domain/identity.errors.js';
import { StaffController } from './staff.controller.js';

type App = Awaited<ReturnType<typeof createFastifyTestApp>>;
const authPort = createMock<AuthPort>();
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const url = (tenantId: string) => `/v1/staff/tenants/${tenantId}/switch-in`;

describe('staff REST API (Fastify, real JWT guards, fake port)', () => {
  let app: App;
  let caller: TestPrincipal;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: AUTH_TEST_IMPORTS,
      controllers: [StaffController],
      providers: [{ provide: AuthPort, useValue: authPort }, ...provideCommonEnhancers()],
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    caller = await principal(app, ['member']);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    authPort.staffSwitchIn.mockReset();
  });

  it('201: caller, tenant, trimmed reason and client reach the port; the body is the staff token', async () => {
    authPort.staffSwitchIn.mockResolvedValue({
      accessToken: 'staff-jwt',
      expiresIn: 900,
      tokenType: 'Bearer',
      tenantId: TENANT,
      auditEventId: 'audit-1',
    });
    const res = await app.inject({
      method: 'POST',
      url: url(TENANT),
      headers: bearer(caller),
      payload: { reason: '  ticket #42  ' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      accessToken: 'staff-jwt',
      expiresIn: 900,
      tokenType: 'Bearer',
      tenantId: TENANT,
      auditEventId: 'audit-1',
    });
    expect(res.json()).not.toHaveProperty('refreshToken');
    expect(authPort.staffSwitchIn).toHaveBeenCalledWith({
      staffUserId: caller.id,
      tenantId: TENANT,
      reason: 'ticket #42',
      client: expect.objectContaining({ ip: expect.any(String) }),
    });
  });

  it.each([
    ['a blank reason', TENANT, { reason: '   ' }],
    ['a 1 001-character reason', TENANT, { reason: 'x'.repeat(1_001) }],
    ['no reason', TENANT, {}],
    ['a malformed tenant id', 'not-a-uuid', { reason: 'r' }],
  ])('400 for %s (Review Focus 5), the port is never called', async (_name, tenantId, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: url(tenantId),
      headers: bearer(caller),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(authPort.staffSwitchIn).not.toHaveBeenCalled();
  });

  it('403 STAFF_ONLY (not staff, or flag revoked since login) and 404 (unknown or nil tenant) from the port', async () => {
    authPort.staffSwitchIn.mockRejectedValueOnce(new NotPlatformStaffException());
    const denied = await app.inject({
      method: 'POST',
      url: url(TENANT),
      headers: bearer(caller),
      payload: { reason: 'r' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'STAFF_ONLY' });

    authPort.staffSwitchIn.mockRejectedValueOnce(
      new EntityNotFoundException('Tenant', TEST_TENANT_ID),
    );
    const missing = await app.inject({
      method: 'POST',
      url: url('00000000-0000-0000-0000-000000000000'),
      headers: bearer(caller),
      payload: { reason: 'r' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('403 STAFF_TOKEN_NOT_ALLOWED for a switch-in token (no self-renewal, no hop); the port is never called', async () => {
    const switchedIn = await principal(app, ['admin'], undefined, TENANT, true);
    const res = await app.inject({
      method: 'POST',
      url: url('0190f3b2-0000-7000-8000-0000000000bb'),
      headers: bearer(switchedIn),
      payload: { reason: 'r' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STAFF_TOKEN_NOT_ALLOWED' });
    expect(authPort.staffSwitchIn).not.toHaveBeenCalled();
  });

  it('401 anonymous', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: url(TENANT),
      payload: { reason: 'r' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(authPort.staffSwitchIn).not.toHaveBeenCalled();
  });
});
