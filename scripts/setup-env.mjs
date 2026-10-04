// Copies every `.env.example` (root + apps/*) to `.env` when missing. Never overwrites.
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dirs = [root, ...readdirSync(join(root, 'apps')).map((name) => join(root, 'apps', name))];

for (const dir of dirs) {
  const example = join(dir, '.env.example');
  const target = join(dir, '.env');
  if (existsSync(example) && !existsSync(target)) {
    copyFileSync(example, target);
    console.info(`created ${target.replace(`${root}/`, '')}`);
  }
}
