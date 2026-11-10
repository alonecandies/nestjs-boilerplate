import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_GCS_IMAGE, RUSTFS_IMAGE } from './emulators.js';

const COMPOSE = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docker-compose.yml'),
  'utf8',
);

describe('storage emulator images', () => {
  it.each([RUSTFS_IMAGE, FAKE_GCS_IMAGE])('%s is the tag docker-compose.yml runs', (image) => {
    const escaped = image.replaceAll('.', '\\.').replaceAll('/', '\\/');
    expect(COMPOSE).toMatch(new RegExp(`^\\s+image: ${escaped}(?:\\s|$)`, 'm'));
  });
});
