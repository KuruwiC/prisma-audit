import { describe, expect, it, vi } from 'vitest';

// Will be implemented
import { findManyByPKs } from '../src/utils/id-generator.js';

const createMockDelegate = (findManyImpl?: (args: unknown) => Promise<Record<string, unknown>[]>) => ({
  findMany: vi.fn(findManyImpl ?? (async () => [])),
});

const makeEntities = (count: number, pkField = 'id'): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ({ [pkField]: `id-${i}`, name: `entity-${i}` }));

describe('findManyByPKs', () => {
  it('should return empty array for empty entities without calling findMany', async () => {
    const delegate = createMockDelegate();
    const result = await findManyByPKs(delegate, ['id'], []);
    expect(result).toEqual([]);
    expect(delegate.findMany).not.toHaveBeenCalled();
  });

  it('should make one findMany call for entities under chunk size', async () => {
    const entities = makeEntities(5);
    const delegate = createMockDelegate(async () => entities);

    const result = await findManyByPKs(delegate, ['id'], entities);

    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(5);
  });

  it('should chunk into multiple findMany calls when exceeding PK_CHUNK_SIZE', async () => {
    const entities = makeEntities(1500);
    const delegate = createMockDelegate(async (args: unknown) => {
      const where = (args as { where: { id: { in: string[] } } }).where;
      const ids = where.id.in;
      return ids.map((id: string) => ({ id, name: `found-${id}` }));
    });

    const result = await findManyByPKs(delegate, ['id'], entities);

    expect(delegate.findMany).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1500);
  });

  it('should correctly merge results from multiple chunks', async () => {
    const entities = makeEntities(2500);
    const delegate = createMockDelegate(async (args: unknown) => {
      const where = (args as { where: { id: { in: string[] } } }).where;
      return where.id.in.map((id: string) => ({ id }));
    });

    const result = await findManyByPKs(delegate, ['id'], entities);

    expect(delegate.findMany).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(2500);
  });

  it('should work with composite primary keys', async () => {
    const entities = [
      { tenantId: 'a', userId: '1', name: 'Alice' },
      { tenantId: 'a', userId: '2', name: 'Bob' },
    ];
    const delegate = createMockDelegate(async () => entities);

    const result = await findManyByPKs(delegate, ['tenantId', 'userId'], entities);

    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const call = delegate.findMany.mock.calls[0];
    const where = (call as unknown[])[0] as { where: { OR: unknown[] } };
    expect(where.where.OR).toHaveLength(2);
    expect(result).toHaveLength(2);
  });
});
