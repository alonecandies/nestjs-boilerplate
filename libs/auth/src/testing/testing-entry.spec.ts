import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/auth entry points', () => {
  it('ships makeAuthUser only on ./testing', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'TEST_RBAC_FEATURE',
      'TEST_TENANT_ID',
      'createTestRbacRegistry',
      'makeAuthUser',
      'signTestAccessToken',
    ]);
    expect(root).not.toHaveProperty('makeAuthUser');
  });
});
