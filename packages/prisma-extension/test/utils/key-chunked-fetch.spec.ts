import { describe, expect, it, vi } from 'vitest';

import { findManyByKeys } from '../../src/utils/id-generation.js';

const createMockDelegate = (findManyImpl?: (args: unknown) => Promise<Record<string, unknown>[]>) => ({
  findMany: vi.fn(findManyImpl ?? (async () => [])),
});

type InArgs = { where: { id: { in: string[] } } };

const makeEntities = (count: number, keyField = 'id'): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ({ [keyField]: `id-${i}`, name: `entity-${i}` }));

describe('findManyByKeys', () => {
  it('should return empty array for empty entities without calling findMany', async () => {
    const delegate = createMockDelegate();
    const result = await findManyByKeys(delegate, ['id'], []);
    expect(result).toEqual([]);
    expect(delegate.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { count: 5, sizes: [5] },
    { count: 1000, sizes: [1000] },
    { count: 1001, sizes: [1000, 1] },
    { count: 1500, sizes: [1000, 500] },
    { count: 2500, sizes: [1000, 1000, 500] },
  ])(
    'splits $count keys into findMany calls of $sizes and returns their rows in call order',
    async ({ count, sizes }) => {
      const entities = makeEntities(count);
      const delegate = createMockDelegate(async (args: unknown) => (args as InArgs).where.id.in.map((id) => ({ id })));

      const result = await findManyByKeys(delegate, ['id'], entities);

      expect(delegate.findMany.mock.calls.map((call) => ((call as unknown[])[0] as InArgs).where.id.in.length)).toEqual(
        sizes,
      );
      expect(result.map((row) => row.id)).toEqual(entities.map((entity) => entity.id));
    },
  );

  it('should work with composite keys', async () => {
    const entities = [
      { tenantId: 'a', userId: '1', name: 'Alice' },
      { tenantId: 'a', userId: '2', name: 'Bob' },
    ];
    const delegate = createMockDelegate(async () => entities);

    const result = await findManyByKeys(delegate, ['tenantId', 'userId'], entities);

    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const call = delegate.findMany.mock.calls[0];
    const where = (call as unknown[])[0] as { where: { OR: unknown[] } };
    expect(where.where.OR).toHaveLength(2);
    expect(result).toHaveLength(2);
  });
});
