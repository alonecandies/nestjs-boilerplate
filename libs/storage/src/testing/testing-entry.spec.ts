import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/storage entry points', () => {
  it('ships InMemoryStorageService only on ./testing', () => {
    expect(Object.keys(testing)).toEqual(['InMemoryStorageService']);
    expect(root).not.toHaveProperty('InMemoryStorageService');
    expect(root).toHaveProperty('StorageService');
  });
});
