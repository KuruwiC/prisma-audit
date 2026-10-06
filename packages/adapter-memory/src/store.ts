/**
 * In-memory store
 *
 * Tables keyed by model and then by serialized primary key, plus the audit-log rows. A
 * transaction runs its callback on a copy-on-write overlay of the store: reads see the
 * overlay's writes first, audit rows written in it stay in a private buffer, and both merge
 * into the store when the callback resolves or are discarded when it throws. An overlay is a
 * store of its own: a transaction opened on it nests inside it, merging into the overlay rather
 * than the store, so the outer transaction's rollback discards it too.
 */

import type { AuditRecord } from '@kuruwic/db-audit-core';

export type MemoryRow = Record<string, unknown>;

/** The handle every read and write runs on: the store itself, or a transaction's overlay of it */
export interface MemoryHandle<TModelName extends string = string> {
  find(model: TModelName, identity: string): MemoryRow | undefined;
  put(model: TModelName, identity: string, row: MemoryRow): void;
  remove(model: TModelName, identity: string): void;
  auditLogs(): readonly AuditRecord[];
  appendAuditLogs(records: readonly AuditRecord[]): void;
}

export interface MemoryStore<TModelName extends string = string> extends MemoryHandle<TModelName> {
  /** Runs `fn` on an overlay that merges into this store when `fn` resolves and is discarded when it throws */
  transaction<T>(fn: (tx: MemoryStore<TModelName>) => Promise<T>): Promise<T>;
}

const DELETED = Symbol('deleted');

type Change = MemoryRow | typeof DELETED;

const getOrCreate = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  map.set(key, created);
  return created;
};

const runTransaction = async <TModelName extends string, T>(
  base: MemoryHandle<TModelName>,
  fn: (tx: MemoryStore<TModelName>) => Promise<T>,
): Promise<T> => {
  const overlay = createOverlay(base);
  const result = await fn(overlay);
  overlay.commit();
  return result;
};

const createOverlay = <TModelName extends string>(
  base: MemoryHandle<TModelName>,
): MemoryStore<TModelName> & { commit(): void } => {
  const changes = new Map<TModelName, Map<string, Change>>();
  const buffer: AuditRecord[] = [];
  const changesOf = (model: TModelName): Map<string, Change> => getOrCreate(changes, model, () => new Map());

  const overlay: MemoryStore<TModelName> & { commit(): void } = {
    find: (model, identity) => {
      const change = changes.get(model)?.get(identity);
      if (change === DELETED) {
        return undefined;
      }
      return change ?? base.find(model, identity);
    },
    put: (model, identity, row) => {
      changesOf(model).set(identity, row);
    },
    remove: (model, identity) => {
      changesOf(model).set(identity, DELETED);
    },
    auditLogs: () => [...base.auditLogs(), ...buffer],
    appendAuditLogs: (records) => {
      buffer.push(...records);
    },
    commit: () => {
      for (const [model, rows] of changes) {
        for (const [identity, change] of rows) {
          if (change === DELETED) {
            base.remove(model, identity);
          } else {
            base.put(model, identity, change);
          }
        }
      }
      base.appendAuditLogs(buffer);
    },
    transaction: (fn) => runTransaction(overlay, fn),
  };
  return overlay;
};

export const createMemoryStore = <TModelName extends string = string>(): MemoryStore<TModelName> => {
  const tables = new Map<TModelName, Map<string, MemoryRow>>();
  const auditLogs: AuditRecord[] = [];
  const tableOf = (model: TModelName): Map<string, MemoryRow> => getOrCreate(tables, model, () => new Map());

  const store: MemoryStore<TModelName> = {
    find: (model, identity) => tables.get(model)?.get(identity),
    put: (model, identity, row) => {
      tableOf(model).set(identity, row);
    },
    remove: (model, identity) => {
      tables.get(model)?.delete(identity);
    },
    auditLogs: () => auditLogs,
    appendAuditLogs: (records) => {
      auditLogs.push(...records);
    },
    transaction: (fn) => runTransaction(store, fn),
  };
  return store;
};
