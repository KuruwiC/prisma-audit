import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedId } from '../src/aggregate/types.js';
import { type ComposeAmbient, type ComposeConfig, compose } from '../src/compose/index.js';
import { IdValidationError } from '../src/domain/branded-types.js';
import type { ResolvedEvent } from '../src/domain/mutation-event.js';
import type { AuditContext } from '../src/types.js';
import type { RedactConfig } from '../src/utils/redaction.js';
import { UNHANDLED } from '../src/utils/serialization.js';

// Lets a test make redaction return a structure it never returns on its own, to reach the type guards.
const redaction = vi.hoisted(() => ({ override: undefined as ((data: unknown) => unknown) | undefined }));

vi.mock('../src/utils/redaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/redaction.js')>();
  return {
    ...actual,
    redactSensitiveData: (data: unknown, config?: RedactConfig): unknown =>
      redaction.override ? redaction.override(data) : actual.redactSensitiveData(data, config),
  };
});

const auditContext: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'user-1' },
  request: { requestId: 'req-1' },
};

const now = new Date('2025-01-01T00:00:00Z');

const postRoot = (id: string): ResolvedId => ({ aggregateCategory: 'model', aggregateType: 'Post', aggregateId: id });

const event = (overrides: Partial<ResolvedEvent> = {}): ResolvedEvent => ({
  model: 'Post',
  identity: 'post-1',
  action: 'create',
  after: { id: 'post-1', title: 'Hello' },
  origin: { path: '', op: 'create' },
  entityId: 'post-1',
  roots: [postRoot('post-1')],
  actorContext: null,
  entityContext: null,
  aggregateContexts: new Map(),
  ...overrides,
});

const updateEvent = (before: Record<string, unknown>, after: Record<string, unknown>): ResolvedEvent =>
  event({ action: 'update', before, after, origin: { path: '', op: 'update' } });

const ambient = (config: Partial<ComposeConfig> = {}): ComposeAmbient => ({
  auditContext,
  config: {
    entity: () => ({ category: 'model', type: 'Post' }),
    excludeFields: [],
    relationFieldNames: () => undefined,
    ...config,
  },
});

const composeOne = (resolved: ResolvedEvent, config?: Partial<ComposeConfig>) => {
  const records = compose([resolved], ambient(config), now);
  expect(records).toHaveLength(1);
  return records[0] as NonNullable<(typeof records)[0]>;
};

describe('compose', () => {
  afterEach(() => {
    redaction.override = undefined;
  });

  describe('records per event', () => {
    it('yields no record for a model without entity configuration', () => {
      expect(compose([event()], ambient({ entity: () => undefined }), now)).toEqual([]);
    });

    it('yields no record for an event without aggregate roots', () => {
      expect(compose([event({ roots: [] })], ambient(), now)).toEqual([]);
    });

    it('yields one record per aggregate root, in root order', () => {
      const roots: ResolvedId[] = [
        postRoot('post-1'),
        { aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'user-9' },
      ];

      const records = compose([event({ roots })], ambient(), now);

      expect(records.map((r) => [r.aggregateCategory, r.aggregateType, r.aggregateId])).toEqual([
        ['model', 'Post', 'post-1'],
        ['model', 'User', 'user-9'],
      ]);
    });

    it('concatenates the records of several events in event order', () => {
      const records = compose([event({ entityId: 'post-1' }), event({ entityId: 'post-2' })], ambient(), now);

      expect(records.map((r) => r.entityId)).toEqual(['post-1', 'post-2']);
    });

    it('stores the entity category and type of the entity configuration', () => {
      const record = composeOne(event(), { entity: () => ({ category: 'content', type: 'Article' }) });

      expect(record.entityCategory).toBe('content');
      expect(record.entityType).toBe('Article');
    });

    it('looks up the entity configuration by the event model', () => {
      const entity = vi.fn(() => ({ category: 'model', type: 'Post' }));

      compose([event({ model: 'Comment' })], ambient({ entity }), now);

      expect(entity).toHaveBeenCalledWith('Comment');
    });
  });

  describe('actor, entity and aggregate fields', () => {
    it('stores the actor from the audit context and the resolved entity id', () => {
      const record = composeOne(event());

      expect(record.actorCategory).toBe('model');
      expect(record.actorType).toBe('User');
      expect(record.actorId).toBe('user-1');
      expect(record.entityId).toBe('post-1');
      expect(record.action).toBe('create');
    });

    it('throws when the resolved entity id is empty', () => {
      expect(() => compose([event({ entityId: '' })], ambient(), now)).toThrow(IdValidationError);
    });

    it('throws when the actor id is empty', () => {
      const ambientWithoutActorId: ComposeAmbient = {
        ...ambient(),
        auditContext: { actor: { category: 'model', type: 'User', id: ' ' } },
      };

      expect(() => compose([event()], ambientWithoutActorId, now)).toThrow(IdValidationError);
    });

    it('looks up each root aggregate context by type and id, null when absent', () => {
      const roots: ResolvedId[] = [
        postRoot('post-1'),
        { aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'user-9' },
      ];
      const aggregateContexts = new Map<string, unknown>([['User:user-9', { name: 'Owner' }]]);

      const records = compose([event({ roots, aggregateContexts })], ambient(), now);

      expect(records.map((r) => r.aggregateContext)).toEqual([null, { name: 'Owner' }]);
    });

    it('stores the actor and entity contexts of the event', () => {
      const record = composeOne(event({ actorContext: { role: 'admin' }, entityContext: { views: 3 } }));

      expect(record.actorContext).toEqual({ role: 'admin' });
      expect(record.entityContext).toEqual({ views: 3 });
    });

    it('stores the request context, null when the audit context carries none', () => {
      expect(composeOne(event()).requestContext).toEqual({ requestId: 'req-1' });

      const withoutRequest: ComposeAmbient = { ...ambient(), auditContext: { actor: auditContext.actor } };
      expect(compose([event()], withoutRequest, now)[0]?.requestContext).toBeNull();
    });

    it('stamps every record with the given time', () => {
      const records = compose([event({ roots: [postRoot('post-1'), postRoot('post-2')] })], ambient(), now);

      expect(records.map((r) => r.createdAt)).toEqual([now, now]);
    });
  });

  describe('states by action', () => {
    it('create: no before state, the row as after state, no changes', () => {
      const record = composeOne(event({ action: 'create', before: { id: 'post-1' }, after: { id: 'post-1' } }));

      expect(record.before).toBeNull();
      expect(record.after).toEqual({ id: 'post-1' });
      expect(record.changes).toBeNull();
    });

    it('delete: the before state, no after state, no changes', () => {
      const record = composeOne(
        event({ action: 'delete', before: { id: 'post-1', title: 'Old' }, after: { id: 'post-1' } }),
      );

      expect(record.before).toEqual({ id: 'post-1', title: 'Old' });
      expect(record.after).toBeNull();
      expect(record.changes).toBeNull();
    });

    it('update: both states and the field-level diff', () => {
      const record = composeOne(updateEvent({ id: 'post-1', title: 'Old' }, { id: 'post-1', title: 'New' }));

      expect(record.before).toEqual({ id: 'post-1', title: 'Old' });
      expect(record.after).toEqual({ id: 'post-1', title: 'New' });
      expect(record.changes).toEqual({ title: { old: 'Old', new: 'New' } });
    });

    it('update without a before state: null before, no changes, still recorded', () => {
      const record = composeOne(event({ action: 'update', after: { id: 'post-1', title: 'New' } }));

      expect(record.before).toBeNull();
      expect(record.changes).toBeNull();
    });
  });

  describe('updates that changed only excluded fields', () => {
    it('skips an update whose changed fields are all excluded globally', () => {
      const resolved = updateEvent({ id: 'post-1', updatedAt: 1 }, { id: 'post-1', updatedAt: 2 });

      expect(compose([resolved], ambient({ excludeFields: ['updatedAt'] }), now)).toEqual([]);
    });

    it('skips an update with no changed fields', () => {
      const resolved = updateEvent({ id: 'post-1', title: 'Same' }, { id: 'post-1', title: 'Same' });

      expect(compose([resolved], ambient(), now)).toEqual([]);
    });

    it('leaves excluded fields out of the changes of a recorded update', () => {
      const resolved = updateEvent(
        { id: 'post-1', title: 'Old', updatedAt: 1 },
        { id: 'post-1', title: 'New', updatedAt: 2 },
      );

      expect(composeOne(resolved, { excludeFields: ['updatedAt'] }).changes).toEqual({
        title: { old: 'Old', new: 'New' },
      });
    });

    it('uses the entity excludeFields in place of the global list', () => {
      const config: Partial<ComposeConfig> = {
        entity: () => ({ category: 'model', type: 'Post', excludeFields: ['title'] }),
        excludeFields: ['updatedAt'],
      };

      const titleOnly = updateEvent({ id: 'post-1', title: 'Old' }, { id: 'post-1', title: 'New' });
      expect(compose([titleOnly], ambient(config), now)).toEqual([]);

      const updatedAtOnly = updateEvent({ id: 'post-1', updatedAt: 1 }, { id: 'post-1', updatedAt: 2 });
      expect(composeOne(updatedAtOnly, config).changes).toEqual({ updatedAt: { old: 1, new: 2 } });
    });

    it('never skips a delete', () => {
      const resolved = event({ action: 'delete', before: { id: 'post-1', updatedAt: 1 } });

      expect(compose([resolved], ambient({ excludeFields: ['updatedAt'] }), now)).toHaveLength(1);
    });
  });

  describe('redaction', () => {
    it('redacts default sensitive fields in before, after and changes once redact is configured', () => {
      const resolved = updateEvent({ id: 'post-1', password: 'old' }, { id: 'post-1', password: 'new' });

      const record = composeOne(resolved, { redact: {} });

      expect(record.before).toEqual({ id: 'post-1', password: { redacted: true, hadValue: true } });
      expect(record.after).toEqual({ id: 'post-1', password: { redacted: true, hadValue: true } });
      expect(record.changes).toEqual({
        password: {
          old: { redacted: true, hadValue: true },
          new: { redacted: true, hadValue: true, isDifferent: true },
        },
      });
    });

    it('redacts the fields named in the redact config', () => {
      const record = composeOne(event({ after: { id: 'post-1', nickname: 'kuro' } }), {
        redact: { fields: ['nickname'] },
      });

      expect(record.after).toEqual({ id: 'post-1', nickname: { redacted: true, hadValue: true } });
    });

    it('stores states verbatim without a redact config', () => {
      const record = composeOne(event({ after: { id: 'post-1', password: 'plain' } }));

      expect(record.after).toEqual({ id: 'post-1', password: 'plain' });
    });

    it('throws when redaction does not return a record for a state', () => {
      redaction.override = () => ['not', 'a', 'record'];

      expect(() => compose([event()], ambient({ redact: {} }), now)).toThrow(
        '[db-audit-core] Redaction produced unexpected type',
      );
    });

    it('throws when redaction does not return a record for the changes', () => {
      // Redaction runs on before, after and then changes.
      let call = 0;
      redaction.override = (data) => (++call === 3 ? ['not', 'a', 'record'] : data);
      const resolved = updateEvent({ id: 'post-1', title: 'Old' }, { id: 'post-1', title: 'New' });

      expect(() => compose([resolved], ambient({ redact: {} }), now)).toThrow(
        '[db-audit-core] Redaction of changes produced unexpected type',
      );
    });
  });

  describe('relations', () => {
    const row = { id: 'post-1', authorId: 'user-9', author: { id: 'user-9', name: 'Owner' } };
    const stripped = { id: 'post-1', authorId: 'user-9' };
    const authorRelation: Partial<ComposeConfig> = { relationFieldNames: () => new Set(['author']) };

    it('strips the relation fields named for the model from both states', () => {
      const record = composeOne(event({ action: 'delete', before: row, after: row }), authorRelation);

      expect(record.before).toEqual(stripped);
      expect(record.after).toBeNull();
    });

    it('asks for the relation field names of the event model', () => {
      const relationFieldNames = vi.fn(() => undefined);

      compose([event({ model: 'Comment' })], ambient({ relationFieldNames }), now);

      expect(relationFieldNames).toHaveBeenCalledWith('Comment');
    });

    it('strips nothing when the model has no relation field names', () => {
      expect(composeOne(event({ after: row })).after).toEqual(row);
    });

    it('keeps relations when the entity includes them, whatever the global setting', () => {
      const record = composeOne(event({ after: row }), {
        ...authorRelation,
        includeRelations: false,
        entity: () => ({ category: 'model', type: 'Post', includeRelations: true }),
      });

      expect(record.after).toEqual(row);
    });

    it('keeps relations when they are included globally and the entity does not say', () => {
      const record = composeOne(event({ after: row }), { ...authorRelation, includeRelations: true });

      expect(record.after).toEqual(row);
    });

    it('strips relations when the entity excludes them, whatever the global setting', () => {
      const record = composeOne(event({ after: row }), {
        ...authorRelation,
        includeRelations: true,
        entity: () => ({ category: 'model', type: 'Post', includeRelations: false }),
      });

      expect(record.after).toEqual(stripped);
    });

    it('strips relations by default', () => {
      expect(composeOne(event({ after: row }), authorRelation).after).toEqual(stripped);
    });
  });

  describe('serialization', () => {
    it('serializes BigInt values in the states and changes', () => {
      const record = composeOne(updateEvent({ id: 'tx-1', amount: 50n }, { id: 'tx-1', amount: 100n }));

      expect(record.before).toEqual({ id: 'tx-1', amount: '50' });
      expect(record.after).toEqual({ id: 'tx-1', amount: '100' });
      expect(record.changes).toEqual({ amount: { old: '50', new: '100' } });
    });

    it('serializes BigInt and Date values in every context field', () => {
      const lastLogin = new Date('2025-06-01T00:00:00.000Z');
      const resolved = event({
        actorContext: { walletId: 999n, lastLogin },
        entityContext: { blockNumber: 12345n },
        aggregateContexts: new Map([['Post:post-1', { total: 7n }]]),
      });
      const withBigIntRequest: ComposeAmbient = {
        ...ambient(),
        auditContext: { actor: auditContext.actor, request: { traceId: 42n } },
      };

      const record = compose([resolved], withBigIntRequest, now)[0];

      expect(record?.actorContext).toEqual({ walletId: '999', lastLogin: '2025-06-01T00:00:00.000Z' });
      expect(record?.entityContext).toEqual({ blockNumber: '12345' });
      expect(record?.aggregateContext).toEqual({ total: '7' });
      expect(record?.requestContext).toEqual({ traceId: '42' });
    });

    it('applies the custom serializers of the serialization config', () => {
      const record = composeOne(event({ actorContext: { data: new Uint8Array([1, 2, 3]) } }), {
        serialization: {
          customSerializers: [(value) => (value instanceof Uint8Array ? `bytes:${value.length}` : UNHANDLED)],
        },
      });

      expect(record.actorContext).toEqual({ data: 'bytes:3' });
    });

    it('keeps createdAt as a Date', () => {
      expect(composeOne(event()).createdAt).toBeInstanceOf(Date);
    });
  });
});
