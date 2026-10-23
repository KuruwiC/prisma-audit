import { describe, expect, it } from 'vitest';
import { type Activity, type Perspective, type Phrase, toActivities } from './activity';
import type { AuditLog } from './api';

let sequence = 0;

type RowInput = Partial<AuditLog> & Pick<AuditLog, 'action' | 'entityType' | 'entityId'>;

const mina = { actorId: 'u_mina', actorContext: { name: 'Mina Sato' } };
const theo = { actorId: 'u_theo', actorContext: { name: 'Theo Lindqvist' } };
const seeder = {
  actorCategory: 'system',
  actorType: 'Seeder',
  actorId: 'demo-seed',
  actorContext: { name: 'Demo seed' },
};

const request = (requestId: string, method: string, path: string) => ({ requestContext: { requestId, method, path } });

/** One written row and the audit row it gets under each aggregate */
const write = (input: RowInput, aggregates: [type: string, id: string, label?: string | null][]): AuditLog[] =>
  aggregates.map(([aggregateType, aggregateId, label]) => {
    sequence += 1;
    return {
      id: `row_${sequence}`,
      actorCategory: 'model',
      actorType: 'User',
      actorId: 'u_mina',
      actorContext: { name: 'Mina Sato' },
      entityContext: null,
      aggregateContext: label === undefined ? null : { label },
      before: null,
      after: null,
      changes: null,
      beforeUnavailable: false,
      requestContext: { requestId: 'req', method: 'POST', path: '/api/posts' },
      createdAt: '2026-10-14T03:00:00.000Z',
      ...input,
      aggregateType,
      aggregateId,
    };
  });

const everything: Perspective = { kind: 'everything' };
const fromAggregate = (type: string, id: string): Perspective => ({ kind: 'aggregate', type, id });

const sentenceOf = (phrase: Phrase) => `${phrase.actor} ${phrase.predicate}`;

const sentences = (activities: Activity[]) => activities.map((activity) => sentenceOf(activity.phrase));

const publishRows = () => {
  const base = { ...mina, ...request('publish', 'POST', '/api/posts') };
  return [
    ...write(
      { ...base, action: 'create', entityType: 'Post', entityId: 'p1', entityContext: { excerpt: 'Hello, audit' } },
      [
        ['Post', 'p1', 'Hello, audit'],
        ['User', 'u_mina', 'Mina Sato'],
      ],
    ),
    ...write(
      { ...base, action: 'create', entityType: 'Tag', entityId: 't_new', after: { id: 't_new', name: 'demo' } },
      [['Tag', 't_new', 'demo']],
    ),
    ...write(
      {
        ...base,
        action: 'create',
        entityType: 'PostTag',
        entityId: 'pt1',
        after: { postId: 'p1', tagId: 't_new' },
        entityContext: { tag: 'demo', postTitle: 'Hello, audit' },
      },
      [
        ['Post', 'p1', 'Hello, audit'],
        ['Tag', 't_new', 'demo'],
      ],
    ),
    ...write(
      {
        ...base,
        action: 'create',
        entityType: 'PostTag',
        entityId: 'pt2',
        after: { postId: 'p1', tagId: 't_old' },
        entityContext: { tag: 'prisma', postTitle: 'Hello, audit' },
      },
      [
        ['Post', 'p1', 'Hello, audit'],
        ['Tag', 't_old', 'prisma'],
      ],
    ),
  ];
};

describe('toActivities', () => {
  it('folds a publish with its tags into one activity, marking the tag the request created', () => {
    const [activity, ...rest] = toActivities(publishRows(), everything);

    expect(rest).toEqual([]);
    expect(sentenceOf(activity.phrase)).toBe('Mina Sato posted');
    expect(activity.phrase.quote).toBe('Hello, audit');
    expect(activity.phrase.tags).toEqual([
      { name: 'demo', created: true },
      { name: 'prisma', created: false },
    ]);
    expect(activity.phrase.details).toEqual([]);
    expect(activity.rowCount).toBe(7);
  });

  it('phrases the post as "this post" from its own history', () => {
    const rows = publishRows().filter((row) => row.aggregateType === 'Post');
    const [activity] = toActivities(rows, fromAggregate('Post', 'p1'));

    expect(sentenceOf(activity.phrase)).toBe('Mina Sato created this post');
    expect(activity.phrase.tags.map((tag) => tag.name)).toEqual(['demo', 'prisma']);
  });

  it("keeps the post as the subject on the author's timeline, where its tag rows are not part of the result", () => {
    const rows = publishRows().filter((row) => row.aggregateType === 'User');
    expect(sentences(toActivities(rows, fromAggregate('User', 'u_mina')))).toEqual(['Mina Sato posted']);
  });

  it('shows a mutation recorded under several aggregates once', () => {
    const rows = write(
      {
        ...theo,
        ...request('comment', 'POST', '/api/posts/p1/comments'),
        action: 'create',
        entityType: 'Comment',
        entityId: 'c1',
        after: { postId: 'p1', authorId: 'u_theo' },
        entityContext: { excerpt: 'Ship it.', postTitle: 'Hello, audit' },
      },
      [
        ['Comment', 'c1', null],
        ['Post', 'p1', 'Hello, audit'],
        ['User', 'u_theo', 'Theo Lindqvist'],
      ],
    );

    const activities = toActivities(rows, everything);
    expect(sentences(activities)).toEqual(['Theo Lindqvist commented on “Hello, audit”']);
    expect(activities[0]?.phrase.quote).toBe('Ship it.');
    expect(sentences(toActivities(rows.slice(1, 2), fromAggregate('Post', 'p1')))).toEqual([
      'Theo Lindqvist commented',
    ]);
    expect(sentences(toActivities(rows.slice(2), fromAggregate('User', 'u_theo')))).toEqual([
      'Theo Lindqvist commented on “Hello, audit”',
    ]);
  });

  it('names a deleted post from the rows of its delete and counts what went with it', () => {
    const base = { ...mina, ...request('delete', 'DELETE', '/api/posts/p1') };
    const rows = [
      ...write(
        {
          ...base,
          action: 'delete',
          entityType: 'Comment',
          entityId: 'c1',
          before: { postId: 'p1', authorId: 'u_theo' },
          entityContext: { excerpt: 'Ship it.', postTitle: 'Hello, audit' },
        },
        [
          ['Comment', 'c1', null],
          ['Post', 'p1', 'Hello, audit'],
          ['User', 'u_theo', 'Theo Lindqvist'],
        ],
      ),
      ...write(
        { ...base, action: 'delete', entityType: 'PostLike', entityId: '["p1","u_theo"]', before: { postId: 'p1' } },
        [
          ['Post', 'p1', 'Hello, audit'],
          ['User', 'u_theo', 'Theo Lindqvist'],
        ],
      ),
      ...write({ ...base, action: 'delete', entityType: 'PostTag', entityId: 'pt1', before: { postId: 'p1' } }, [
        ['Post', 'p1', 'Hello, audit'],
        ['Tag', 't_new', 'demo'],
      ]),
      ...write(
        {
          ...base,
          action: 'delete',
          entityType: 'Post',
          entityId: 'p1',
          before: { id: 'p1', title: 'Hello, audit' },
          entityContext: { excerpt: 'Hello, audit' },
        },
        [
          ['Post', 'p1', null],
          ['User', 'u_mina', 'Mina Sato'],
        ],
      ),
    ];

    const [activity, ...rest] = toActivities(rows, everything);
    expect(rest).toEqual([]);
    expect(sentenceOf(activity.phrase)).toBe('Mina Sato deleted “Hello, audit”');
    expect(activity.phrase.details).toEqual(['Along with 1 comment, 1 like, and 1 tag']);
  });

  it('phrases a bio change that writes only the profile', () => {
    const rows = write(
      {
        ...mina,
        ...request('bio', 'PATCH', '/api/users/u_mina'),
        action: 'update',
        entityType: 'Profile',
        entityId: 'pr1',
        after: { userId: 'u_mina', bio: 'Thinks in aggregates.' },
        changes: { bio: { old: 'Hi', new: 'Thinks in aggregates.' } },
      },
      [
        ['Profile', 'pr1'],
        ['User', 'u_mina', 'Mina Sato'],
      ],
    );

    const [activity] = toActivities(rows, everything);
    expect(sentenceOf(activity.phrase)).toBe('Mina Sato updated their bio');
    expect(activity.phrase.quote).toBe('Thinks in aggregates.');
  });

  it('folds a password change and the bio written with it into one account update', () => {
    const base = { ...mina, ...request('account', 'PATCH', '/api/users/u_mina') };
    const rows = [
      ...write(
        {
          ...base,
          action: 'update',
          entityType: 'User',
          entityId: 'u_mina',
          changes: { password: { old: null, new: { redacted: true, hadValue: true } } },
        },
        [['User', 'u_mina', 'Mina Sato']],
      ),
      ...write(
        { ...base, action: 'create', entityType: 'Profile', entityId: 'pr1', after: { userId: 'u_mina', bio: 'Hi' } },
        [
          ['Profile', 'pr1'],
          ['User', 'u_mina', 'Mina Sato'],
        ],
      ),
    ];

    expect(sentences(toActivities(rows, everything))).toEqual(['Mina Sato updated their password and bio']);
    expect(sentences(toActivities(rows.slice(0, 1), everything))).toEqual(['Mina Sato changed their password']);
  });

  it("phrases the seeder's account creation from the account's side", () => {
    const base = { ...seeder, ...request('seed-1', 'SEED', 'seed.ts user') };
    const rows = [
      ...write(
        {
          ...base,
          action: 'create',
          entityType: 'User',
          entityId: 'u_mina',
          after: { id: 'u_mina', name: 'Mina Sato' },
        },
        [['User', 'u_mina', 'Mina Sato']],
      ),
      ...write(
        { ...base, action: 'create', entityType: 'Profile', entityId: 'pr1', after: { userId: 'u_mina', bio: 'Hi' } },
        [
          ['Profile', 'pr1'],
          ['User', 'u_mina', 'Mina Sato'],
        ],
      ),
    ];

    const [activity] = toActivities(rows, everything);
    expect(sentenceOf(activity.phrase)).toBe('Demo seed created the account of Mina Sato');
    expect(activity.phrase.details).toEqual(['With a bio']);
    expect(sentences(toActivities(rows, fromAggregate('User', 'u_mina')))).toEqual(['Demo seed created this account']);
  });

  it('keeps a like and its undo as two activities, newest first', () => {
    const like = (requestId: string, action: 'create' | 'delete', createdAt: string) =>
      write(
        {
          ...theo,
          ...request(requestId, action === 'create' ? 'PUT' : 'DELETE', '/api/posts/p1/like'),
          action,
          entityType: 'PostLike',
          entityId: '["p1","u_theo"]',
          createdAt,
          [action === 'create' ? 'after' : 'before']: { postId: 'p1', userId: 'u_theo' },
          entityContext: { postTitle: 'Hello, audit' },
        },
        [
          ['Post', 'p1', 'Hello, audit'],
          ['User', 'u_theo', 'Theo Lindqvist'],
        ],
      );
    const rows = [
      ...like('unlike', 'delete', '2026-10-14T03:00:05.000Z'),
      ...like('like', 'create', '2026-10-14T03:00:01.000Z'),
    ];

    expect(sentences(toActivities(rows, everything))).toEqual([
      'Theo Lindqvist unliked “Hello, audit”',
      'Theo Lindqvist liked “Hello, audit”',
    ]);
    expect(sentences(toActivities(rows, fromAggregate('Post', 'p1')))).toEqual([
      'Theo Lindqvist unliked this post',
      'Theo Lindqvist liked this post',
    ]);
  });

  it('marks an edit that changed no field as quiet', () => {
    const rows = write(
      {
        ...mina,
        ...request('noop', 'PATCH', '/api/posts/p1'),
        action: 'update',
        entityType: 'Post',
        entityId: 'p1',
        changes: {},
        entityContext: { excerpt: 'Hello, audit' },
      },
      [
        ['Post', 'p1', 'Hello, audit'],
        ['User', 'u_mina', 'Mina Sato'],
      ],
    );

    const [activity] = toActivities(rows, everything);
    expect(sentenceOf(activity.phrase)).toBe('Mina Sato edited “Hello, audit”');
    expect(activity.phrase.quiet).toBe(true);
    expect(activity.phrase.details).toEqual(['No field changed']);
  });
});
