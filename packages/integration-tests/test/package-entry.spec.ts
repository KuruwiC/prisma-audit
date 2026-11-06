/**
 * The published packages load with `require` as well as `import`: on the Node versions their
 * `engines` name, `require` of an ES module without top-level await returns its namespace.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('package entry', () => {
  it.each([
    ['@kuruwic/prisma-audit', 'createAuditClient'],
    ['@kuruwic/db-audit-core', 'createTransactionAudit'],
  ])('loads %s with require', (name, exported) => {
    const loaded: unknown = require(name);

    expect(loaded).toHaveProperty(exported, expect.any(Function));
  });
});
