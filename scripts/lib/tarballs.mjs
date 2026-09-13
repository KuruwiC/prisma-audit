import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Lists the `.tgz` files in `dir`, sorted, as paths joined onto `dir` (absolute when `dir` is).
 */
export function listTarballs(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => path.join(dir, file))
    .sort();
}
