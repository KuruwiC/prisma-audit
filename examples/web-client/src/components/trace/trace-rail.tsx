import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { api } from '@/lib/api';
import { groupByRequest, type RequestGroup } from '@/lib/audit';
import { type Rollback, useRollbacks } from '@/lib/rollbacks';
import { RequestGroupView, RollbackView } from './request-group';

const RAIL_QUERY_KEY = ['audit', 'rail'] as const;

type Entry = { kind: 'group'; at: string; group: RequestGroup } | { kind: 'rollback'; at: string; rollback: Rollback };

export const TraceRail = ({ onNewRequests }: { onNewRequests?: (requestIds: string[]) => void }) => {
  const { data: logs } = useQuery({
    queryKey: RAIL_QUERY_KEY,
    queryFn: () => api.auditLogs({ limit: 120 }),
    refetchInterval: 2000,
  });
  const { rollbacks } = useRollbacks();
  const seen = useRef<Set<string> | null>(null);

  const groups = useMemo(() => groupByRequest(logs ?? []), [logs]);

  const fresh = new Set<string>();
  if (seen.current) {
    for (const group of groups) if (!seen.current.has(group.requestId)) fresh.add(group.requestId);
  }

  useEffect(() => {
    if (!logs) return;
    const known = seen.current;
    seen.current = new Set(groups.map((group) => group.requestId));
    if (known) onNewRequests?.(groups.filter((group) => !known.has(group.requestId)).map((group) => group.requestId));
  }, [logs, groups, onNewRequests]);

  const entries: Entry[] = [
    ...groups.map((group): Entry => ({ kind: 'group', at: group.createdAt, group })),
    ...rollbacks.map((rollback): Entry => ({ kind: 'rollback', at: rollback.at, rollback })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section aria-labelledby="trail-heading" className="flex h-full flex-col bg-trace text-trace-ink">
      <header className="border-b border-trace-line px-5 pt-5 pb-4">
        <h2 id="trail-heading" className="text-lg font-semibold">
          Audit trail
        </h2>
        <p className="mt-1 max-w-[42ch] text-sm text-trace-muted">
          What the database recorded. The handlers only call Prisma; the extension wrote every row below.
        </p>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {logs === undefined ? <p className="px-1 text-sm text-trace-muted">Loading the audit table…</p> : null}
        {logs?.length === 0 && rollbacks.length === 0 ? (
          <p className="px-1 text-sm text-trace-muted">
            No rows yet. Post, comment or like something to write the first one.
          </p>
        ) : null}
        {entries.map((entry) =>
          entry.kind === 'group' ? (
            <RequestGroupView
              key={entry.group.requestId}
              group={entry.group}
              fresh={fresh.has(entry.group.requestId)}
            />
          ) : (
            <RollbackView key={entry.rollback.requestId} rollback={entry.rollback} />
          ),
        )}
      </div>
    </section>
  );
};
