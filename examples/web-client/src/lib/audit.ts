import type { AuditAction, AuditLog } from './api';

/** The aggregate roots of the demo; each owns a hue in the UI */
export const AGGREGATE_KINDS = { User: 'user', Post: 'post', Comment: 'comment', Tag: 'tag' } as const;

export type AggregateType = keyof typeof AGGREGATE_KINDS;
export type AggregateKind = (typeof AGGREGATE_KINDS)[AggregateType];

const isAggregateType = (type: string): type is AggregateType => Object.hasOwn(AGGREGATE_KINDS, type);

export const aggregateKind = (type: string): AggregateKind | null =>
  isAggregateType(type) ? AGGREGATE_KINDS[type] : null;

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
};

export const actorName = (log: AuditLog) =>
  log.actorContext?.name ??
  (log.actorCategory === 'system' ? 'Demo seed' : log.actorCategory === 'anonymous' ? 'A visitor' : 'Someone');

export const aggregateLabel = (log: AuditLog) =>
  log.aggregateContext?.label ??
  (log.aggregateType === log.entityType ? stringField(log.entityContext, 'excerpt') : null) ??
  stringField(log.after, 'title') ??
  stringField(log.before, 'title') ??
  stringField(log.after, 'name') ??
  stringField(log.before, 'name') ??
  shortId(log.aggregateId);

export const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/** The Prisma delegate call that would produce a row of this entity and action */
export const prismaCall = (entityType: string, action: AuditAction) =>
  `prisma.${entityType.charAt(0).toLowerCase()}${entityType.slice(1)}.${action}()`;

const requestIdOf = (log: AuditLog) => log.requestContext?.requestId ?? `row:${log.id}`;

export type Mutation = {
  key: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  /** One row per aggregate the mutation was recorded under */
  projections: AuditLog[];
};

export type RequestGroup = {
  requestId: string;
  method: string;
  path: string;
  createdAt: string;
  rowCount: number;
  mutations: Mutation[];
};

/**
 * Groups rows (newest first) into the requests that wrote them, and each request's rows into the
 * row mutations they record: one mutation fans out to a row per aggregate
 */
export const groupByRequest = (logs: AuditLog[]): RequestGroup[] => {
  const groups = new Map<string, RequestGroup>();
  for (const log of logs) {
    const requestId = requestIdOf(log);
    let group = groups.get(requestId);
    if (!group) {
      group = {
        requestId,
        method: log.requestContext?.method ?? '',
        path: log.requestContext?.path ?? '',
        createdAt: log.createdAt,
        rowCount: 0,
        mutations: [],
      };
      groups.set(requestId, group);
    }
    group.rowCount += 1;
    const key = `${log.action}:${log.entityType}:${log.entityId}`;
    let mutation = group.mutations.find((candidate) => candidate.key === key);
    if (!mutation) {
      mutation = { key, entityType: log.entityType, entityId: log.entityId, action: log.action, projections: [] };
      group.mutations.push(mutation);
    }
    mutation.projections.push(log);
  }
  for (const group of groups.values()) {
    // Rows of one request share a timestamp inside a transaction; show the parent entity first
    group.mutations.reverse();
    for (const mutation of group.mutations) {
      mutation.projections.sort(
        (a, b) => Number(b.aggregateType === mutation.entityType) - Number(a.aggregateType === mutation.entityType),
      );
    }
  }
  return [...groups.values()];
};

export const isRedacted = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'redacted' in value && value.redacted === true;
