import { describe, expect, it } from 'vitest';
import { foreignKey, resolveAggregateId, self, to } from '../../src/aggregate/helpers.js';

describe('resolveAggregateId', () => {
  it('should resolve direct id from entity', async () => {
    const entity = { id: 'user-123', name: 'John' };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('user-123');
  });

  it('should resolve foreign key id', async () => {
    const entity = { id: 'post-456', authorId: 'user-789' };
    const aggregateRoot = to('User', foreignKey('authorId'));

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('user-789');
  });

  it('should return null on missing self id', async () => {
    const entity = { name: 'John' };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBeNull();
  });

  it('should return null on missing foreign key', async () => {
    const entity = { id: 'post-456' };
    const aggregateRoot = to('User', foreignKey('authorId'));

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBeNull();
  });

  it('should normalize resolved ids', async () => {
    const entity = { id: 42 };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('42');
  });
});
