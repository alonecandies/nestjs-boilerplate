import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/transport entry points', () => {
  it('ships the test doubles, the test principal signer and withBoundGrpcPort only on ./testing', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'FakeKafkaProducer',
      'createTestPrincipalSigner',
      'withBoundGrpcPort',
    ]);
    expect(root).not.toHaveProperty('FakeKafkaProducer');
    expect(root).not.toHaveProperty('createTestPrincipalSigner');
    expect(root).not.toHaveProperty('withBoundGrpcPort');
    expect(root).toHaveProperty('KafkaProducer');
  });
});
