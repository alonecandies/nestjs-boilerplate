import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/transport entry points', () => {
  it('ships FakeKafkaProducer and the test principal signer only on ./testing', () => {
    expect(Object.keys(testing).sort()).toEqual(['FakeKafkaProducer', 'createTestPrincipalSigner']);
    expect(root).not.toHaveProperty('FakeKafkaProducer');
    expect(root).not.toHaveProperty('createTestPrincipalSigner');
    expect(root).toHaveProperty('KafkaProducer');
  });
});
