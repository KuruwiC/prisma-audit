/**
 * A nested to-one `update` / `upsert` / `delete` is not addressed by a unique WHERE, so its pre-fetch derives
 * the related row from the schema's relation link (`relationFromFields` / `relationToFields`, every
 * field of a composite key) and the key of the parent row: the top-level row for a direct child,
 * the rows pre-fetched at the parent path for a deeper one.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-to-one-actor' },
};

const createClients = (databaseUrl: string, observer: AuditErrorObserver) => {
  const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    nestedOperations: {
      update: { fetchBeforeOperation: true },
      delete: { fetchBeforeOperation: true },
    },
    errorHandling: { observer },
  });
  return { basePrisma, provider, prisma };
};

describe('nested to-one pre-fetch', () => {
  let databaseUrl: string;
  let observer: ReturnType<typeof vi.fn<AuditErrorObserver>>;
  let clients: ReturnType<typeof createClients>;

  const asActor = <T>(fn: () => Promise<T>): Promise<T> => clients.provider.runAsync(testActor, fn);

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(async () => {
    observer = vi.fn<AuditErrorObserver>();
    clients = createClients(databaseUrl, observer);
    await cleanDatabase(clients.basePrisma);
  });

  afterEach(async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
  });

  const createUser = (email: string, name: string) =>
    clients.basePrisma.user.create({ data: { email, name, password: 'secret123' } });

  const createBookmarkWithNote = async (label: string, body: string) => {
    const user = await createUser('bookmark-owner@example.com', 'Owner');
    const post = await clients.basePrisma.post.create({ data: { title: 'Post', authorId: user.id } });
    const bookmark = await clients.basePrisma.postBookmark.create({
      data: { postId: post.id, userId: user.id, label },
    });
    const note = await clients.basePrisma.postBookmarkNote.create({
      data: { postId: post.id, userId: user.id, body },
    });
    return { user, post, bookmark, note };
  };

  describe('owning side', () => {
    it('captures the before-state of the related row an update targets through the foreign key', async () => {
      const author = await createUser('author@example.com', 'Before');
      const post = await clients.basePrisma.post.create({ data: { title: 'Post', authorId: author.id } });

      await asActor(() =>
        clients.prisma.post.update({
          where: { id: post.id },
          data: { author: { update: { name: 'After' } } },
          include: { author: true },
        }),
      );

      const userLogs = await clients.basePrisma.auditLog.findMany({
        where: { entityType: 'User', entityId: author.id },
      });
      expect(userLogs.length).toBeGreaterThan(0);
      for (const log of userLogs) {
        expect(log.action).toBe('update');
        expect((log.before as Record<string, unknown> | null)?.name).toBe('Before');
        expect((log.after as Record<string, unknown> | null)?.name).toBe('After');
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('logs an upsert on an existing related row as an update', async () => {
      const user = await createUser('profile-owner@example.com', 'Before');
      const profile = await clients.basePrisma.profile.create({ data: { userId: user.id, bio: 'bio' } });

      await asActor(() =>
        clients.prisma.profile.update({
          where: { id: profile.id },
          data: {
            user: {
              upsert: {
                create: { email: 'never-created@example.com', name: 'Created' },
                update: { name: 'After' },
              },
            },
          },
          include: { user: true },
        }),
      );

      const userLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'User' } });
      expect(userLogs.length).toBeGreaterThan(0);
      for (const log of userLogs) {
        expect(log.entityId).toBe(user.id);
        expect(log.action).toBe('update');
        expect((log.before as Record<string, unknown> | null)?.name).toBe('Before');
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('captures the before-state of a related row referenced by a composite foreign key', async () => {
      const { bookmark, note } = await createBookmarkWithNote('Before', 'body');

      await asActor(() =>
        clients.prisma.postBookmarkNote.update({
          where: { id: note.id },
          data: { bookmark: { update: { label: 'After' } } },
          include: { bookmark: true },
        }),
      );

      const bookmarkLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'PostBookmark' } });
      expect(bookmarkLogs.length).toBeGreaterThan(0);
      for (const log of bookmarkLogs) {
        expect(log.entityId).toBe(JSON.stringify([bookmark.postId, bookmark.userId]));
        expect(log.action).toBe('update');
        expect((log.before as Record<string, unknown> | null)?.label).toBe('Before');
      }
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('inverse side', () => {
    it('skips the pre-fetch of a child nested under an upsert whose parent row does not exist yet', async () => {
      const user = await createUser('no-profile@example.com', 'User');

      await asActor(() =>
        clients.prisma.user.update({
          where: { email: user.email },
          data: {
            profile: {
              upsert: {
                create: { bio: 'New bio' },
                update: { avatar: { update: { name: 'Avatar' } } },
              },
            },
          },
          include: { profile: true },
        }),
      );

      const profileLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'Profile' } });
      expect(profileLogs.length).toBeGreaterThan(0);
      for (const log of profileLogs) {
        expect(log.action).toBe('create');
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('captures the before-state of a to-one delete whose back-relation spans a composite key', async () => {
      const { bookmark, note } = await createBookmarkWithNote('label', 'Note body');

      await asActor(() =>
        clients.prisma.postBookmark.update({
          where: { bookmarkKey: { postId: bookmark.postId, userId: bookmark.userId } },
          data: { note: { delete: true } },
        }),
      );

      const noteLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'PostBookmarkNote' } });
      expect(noteLogs.length).toBeGreaterThan(0);
      for (const log of noteLogs) {
        expect(log.entityId).toBe(note.id);
        expect(log.action).toBe('delete');
        expect((log.before as Record<string, unknown> | null)?.body).toBe('Note body');
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('captures the before-state of a to-one update whose back-relation spans a composite key', async () => {
      const { bookmark, note } = await createBookmarkWithNote('label', 'Before');

      await asActor(() =>
        clients.prisma.postBookmark.update({
          where: { bookmarkKey: { postId: bookmark.postId, userId: bookmark.userId } },
          data: { note: { update: { body: 'After' } } },
          include: { note: true },
        }),
      );

      const noteLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'PostBookmarkNote' } });
      expect(noteLogs.length).toBeGreaterThan(0);
      for (const log of noteLogs) {
        expect(log.entityId).toBe(note.id);
        expect(log.action).toBe('update');
        expect((log.before as Record<string, unknown> | null)?.body).toBe('Before');
      }
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('connectOrCreate on a composite-key model', () => {
    it('writes no log for the related row when it already exists', async () => {
      const { user, post } = await createBookmarkWithNote('Existing', 'body');
      await clients.basePrisma.postBookmarkNote.deleteMany();

      await asActor(() =>
        clients.prisma.postBookmarkNote.create({
          data: {
            body: 'New note',
            bookmark: {
              connectOrCreate: {
                where: { bookmarkKey: { postId: post.id, userId: user.id } },
                create: { postId: post.id, userId: user.id, label: 'Created' },
              },
            },
          },
          include: { bookmark: true },
        }),
      );

      const bookmarkLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'PostBookmark' } });
      expect(bookmarkLogs).toHaveLength(0);
      expect(observer).not.toHaveBeenCalled();
    });

    it('writes a create log keyed by the composite identity when the related row is new', async () => {
      const user = await createUser('new-bookmark@example.com', 'Owner');
      const post = await clients.basePrisma.post.create({ data: { title: 'Post', authorId: user.id } });

      await asActor(() =>
        clients.prisma.postBookmarkNote.create({
          data: {
            body: 'New note',
            bookmark: {
              connectOrCreate: {
                where: { bookmarkKey: { postId: post.id, userId: user.id } },
                create: { postId: post.id, userId: user.id, label: 'Created' },
              },
            },
          },
          include: { bookmark: true },
        }),
      );

      const bookmarkLogs = await clients.basePrisma.auditLog.findMany({ where: { entityType: 'PostBookmark' } });
      expect(bookmarkLogs.length).toBeGreaterThan(0);
      for (const log of bookmarkLogs) {
        expect(log.entityId).toBe(JSON.stringify([post.id, user.id]));
        expect(log.action).toBe('create');
      }
      expect(observer).not.toHaveBeenCalled();
    });
  });
});
