import { getBasePrisma } from '@kuruwic/prisma-audit-database';
import { titleOf } from './post-title.js';
import { type AuditContext, auditProvider, prisma } from './prisma.js';

const seeder: AuditContext['actor'] = { category: 'system', type: 'Seeder', id: 'demo-seed', name: 'Demo seed' };

const people = [
  { key: 'mina', name: 'Mina Sato', bio: 'Backend engineer. Thinks in aggregates.' },
  { key: 'theo', name: 'Theo Lindqvist', bio: 'Reads audit logs for fun.' },
  { key: 'priya', name: 'Priya Raman', bio: 'On call more often than not.' },
] as const;

type PersonKey = (typeof people)[number]['key'];

const posts: { author: PersonKey; content: string; tags: string[] }[] = [
  {
    author: 'priya',
    content:
      'Rolled back a migration at 2am. The audit trail rolled back with it, so there were no half-written rows to clean up.',
    tags: ['postgres', 'transactions'],
  },
  {
    author: 'theo',
    content: 'The audit log is the most honest onboarding doc we have. It tells you what the app actually does.',
    tags: ['audit'],
  },
  {
    author: 'mina',
    content:
      "Every comment and like now shows up on the post's own timeline, and nobody touched a handler to make it happen.",
    tags: ['prisma', 'ddd'],
  },
];

const comments: { author: PersonKey; post: number; content: string }[] = [
  { author: 'mina', post: 0, content: 'Same transaction, same fate. That is the whole point.' },
  { author: 'priya', post: 2, content: 'Which aggregate does a like land on?' },
  { author: 'mina', post: 2, content: 'Both: the post it is on and the person who liked it.' },
];

const likes: { author: PersonKey; post: number }[] = [
  { author: 'theo', post: 0 },
  { author: 'priya', post: 2 },
  { author: 'theo', post: 2 },
];

const asUser = (id: string) => ({ category: 'model', type: 'User', id }) as const;

export const seedDemo = async () => {
  let count = 0;

  /** Each step is its own operation, as a request would be: a fresh request id, attributed to the author when it has one */
  const step = <T>(name: string, personId: string | null, write: () => Promise<T>): Promise<T> => {
    count += 1;
    const context: AuditContext = {
      actor: seeder,
      request: { requestId: `seed-${count}`, method: 'SEED', path: `seed.ts ${name}` },
    };
    return auditProvider.runAsync(context, () =>
      personId ? auditProvider.withActor(asUser(personId), write) : write(),
    );
  };

  const ids = new Map<PersonKey, string>();
  for (const person of people) {
    const user = await step('user', null, () =>
      prisma.user.create({
        data: { name: person.name, email: `${person.key}@example.test`, profile: { create: { bio: person.bio } } },
      }),
    );
    ids.set(person.key, user.id);
  }
  const idOf = (key: PersonKey) => {
    const id = ids.get(key);
    if (!id) throw new Error(`Seed person ${key} was not created`);
    return id;
  };

  const postIds: string[] = [];
  for (const post of posts) {
    const authorId = idOf(post.author);
    const created = await step('post', authorId, () =>
      prisma.post.create({
        data: {
          title: titleOf(post.content),
          content: post.content,
          published: true,
          authorId,
          postTags: {
            create: post.tags.map((name) => ({ tag: { connectOrCreate: { where: { name }, create: { name } } } })),
          },
        },
      }),
    );
    postIds.push(created.id);
  }
  const postIdAt = (index: number) => {
    const id = postIds[index];
    if (!id) throw new Error(`Seed post ${index} was not created`);
    return id;
  };

  for (const comment of comments) {
    const authorId = idOf(comment.author);
    await step('comment', authorId, () =>
      prisma.comment.create({ data: { content: comment.content, postId: postIdAt(comment.post), authorId } }),
    );
  }
  for (const like of likes) {
    const userId = idOf(like.author);
    await step('like', userId, () => prisma.postLike.create({ data: { postId: postIdAt(like.post), userId } }));
  }
};

/** Wipes through the base client so the wipe leaves no audit rows, then seeds again */
export const resetDemo = async () => {
  const db = getBasePrisma();
  await db.$transaction([
    db.auditLog.deleteMany(),
    db.postLike.deleteMany(),
    db.postTag.deleteMany(),
    db.comment.deleteMany(),
    db.post.deleteMany(),
    db.tag.deleteMany(),
    db.profile.deleteMany(),
    db.user.deleteMany(),
  ]);
  await seedDemo();
};
