import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/transport entry points', () => {
  it('ships FakeKafkaProducer only on ./testing', () => {
    expect(Object.keys(testing)).toEqual(['FakeKafkaProducer']);
    expect(root).not.toHaveProperty('FakeKafkaProducer');
    expect(root).toHaveProperty('KafkaProducer');
  });
});
