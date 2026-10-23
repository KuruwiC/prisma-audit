/**
 * The columns an audit record stores of a row
 *
 * A record holds the client's default shape of its row, plus the omitted fields its entity records.
 * A column a caller names in its `select` or `omit`, or one a widened `select` adds on a client that
 * takes no query `omit`, can be one a client-level `omit` hides, which the audit cannot tell from
 * the row alone. A row whose before state was read holds exactly the audited columns in that state,
 * so its after state keeps only the columns its before state holds. A row without one keeps the
 * columns the caller named, as the caller read them, and leaves out the widened ones.
 *
 * @module pipeline/audited-columns
 */

import type { MutationEvent } from '@kuruwic/db-audit-core';
import type { WidenedColumns } from '../utils/audited-selection.js';

const pickColumns = (row: Record<string, unknown>, kept: (column: string) => boolean): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([column]) => kept(column)));

/** `event` with its after state left to the columns a record stores; `event` itself when it holds no other */
export const keepAuditedColumns = <TEvent extends MutationEvent>(event: TEvent, widened: WidenedColumns): TEvent => {
  const { after, before } = event;
  if (!after) {
    return event;
  }
  const kept: (column: string) => boolean =
    before.kind === 'captured'
      ? (column) => column in before.row
      : (column) => !(widened.get(event.model)?.has(column) ?? false);
  return Object.keys(after).every(kept) ? event : { ...event, after: pickColumns(after, kept) };
};
