/** Unit tests for operation arguments as Prisma sends them: `toJSON` of every plain object resolved, other values untouched. */

import { describe, expect, it } from 'vitest';
import { argumentsAsSent } from '../../src/utils/arguments-as-sent.js';

const sentAs = (value: unknown) => ({ toJSON: () => value });

describe('argumentsAsSent', () => {
  it('replaces a plain object holding a toJSON function with what it returns, at any depth', () => {
    const args = {
      where: { id: 'u1' },
      data: { posts: sentAs({ create: [{ title: 'a' }] }), tags: [sentAs({ connect: { id: 't1' } })] },
    };

    expect(argumentsAsSent(args)).toEqual({
      where: { id: 'u1' },
      data: { posts: { create: [{ title: 'a' }] }, tags: [{ connect: { id: 't1' } }] },
    });
  });

  it('resolves the toJSON of what a toJSON returns, and of the plain objects it holds', () => {
    const args = { data: { posts: sentAs(sentAs({ create: sentAs({ title: 'a' }) })) } };

    expect(argumentsAsSent(args)).toEqual({ data: { posts: { create: { title: 'a' } } } });
  });

  it('leaves every value that is not a plain object or a list as it is, a class instance holding toJSON included', () => {
    class Decimal {
      constructor(readonly value: string) {}
      toJSON() {
        return this.value;
      }
    }
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const score = new Decimal('1.5');
    const bytes = new Uint8Array([1, 2]);

    const sent = argumentsAsSent({ data: { createdAt, score, bytes, big: 10n, name: null } });

    expect(sent).toEqual({ data: { createdAt, score, bytes, big: 10n, name: null } });
    const data = Reflect.get(Object(sent), 'data');
    expect(Reflect.get(data, 'createdAt')).toBe(createdAt);
    expect(Reflect.get(data, 'score')).toBe(score);
    expect(Reflect.get(data, 'bytes')).toBe(bytes);
  });

  it('returns fresh plain objects and lists, so a change made to the arguments afterwards does not reach them', () => {
    const data: Record<string, unknown> = { posts: { create: [{ title: 'a' }] } };
    const args = { data };

    const sent = argumentsAsSent(args);
    data.profile = { create: {} };
    const posts: unknown = Reflect.get(data, 'posts');
    if (typeof posts === 'object' && posts !== null) {
      Reflect.set(posts, 'connect', { id: 'p1' });
    }

    expect(sent).toEqual({ data: { posts: { create: [{ title: 'a' }] } } });
  });

  it('reads the own fields of a plain object whose toJSON returns the object itself', () => {
    const posts = {
      create: { title: 'a' },
      toJSON() {
        return this;
      },
    };

    const sent = argumentsAsSent({ data: { posts } });

    expect(sent).toMatchObject({ data: { posts: { create: { title: 'a' } } } });
  });

  it('keeps a toJSON that is not a function, and an own __proto__ key, as data', () => {
    const args = JSON.parse('{"data":{"toJSON":"text","__proto__":{"polluted":true}}}');

    const sent = argumentsAsSent(args);

    expect(Object.getPrototypeOf(Reflect.get(Object(sent), 'data'))).toBe(Object.prototype);
    expect(Object.keys(Reflect.get(Object(sent), 'data'))).toEqual(['toJSON', '__proto__']);
  });
});
