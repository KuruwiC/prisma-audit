/**
 * Lists the `.tgz` files in `dir`, as absolute paths sorted alphabetically.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

export function listTarballs(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => path.join(dir, file))
    .sort();
}
