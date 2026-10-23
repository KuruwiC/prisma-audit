import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ChangeList } from '@/components/trace/change-list';
import { ActionMark } from '@/components/ui/action-mark';
import { AggregateChip } from '@/components/ui/aggregate-chip';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/drawer';
import { useActor } from '@/lib/actor';
import { type AuditFilter, type AuditLog, api } from '@/lib/api';
import { AGGREGATE_KINDS, actorName, aggregateLabel, shortId } from '@/lib/audit';
import { plural } from '@/lib/plural';
import { Link } from '@/lib/router';
import { clockTime, fullTime } from '@/lib/time';

const AGGREGATE_TYPES = Object.keys(AGGREGATE_KINDS);
const ACTIONS = ['create', 'update', 'delete'] as const;

const selectClass = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-1.5">
    <h3 className="text-sm font-semibold">{title}</h3>
    {children}
  </section>
);

const Json = ({ value }: { value: unknown }) => (
  <pre className="overflow-x-auto rounded-control bg-trace-raised px-3 py-2.5 text-trace-ink">
    <code>{value === null || value === undefined ? 'null' : JSON.stringify(value, null, 2)}</code>
  </pre>
);

const RowDetail = ({ log }: { log: AuditLog }) => (
  <div className="space-y-5 text-sm">
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
      <dt className="text-trace-muted">Actor</dt>
      <dd>
        <span className="label-inline">{actorName(log)}</span>{' '}
        <code className="text-trace-muted">{`${log.actorCategory}/${log.actorType}/${log.actorId}`}</code>
      </dd>
      <dt className="text-trace-muted">Entity</dt>
      <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AggregateChip type={log.entityType} label={log.entityId} tone="trace" />
        <Link
          to={{ name: 'config', section: log.entityType }}
          className="label text-xs text-trace-ink underline decoration-trace-muted underline-offset-2 hover:decoration-trace-ink"
        >
          See its mapping
        </Link>
      </dd>
      <dt className="text-trace-muted">Aggregate</dt>
      <dd>
        <AggregateChip type={log.aggregateType} label={aggregateLabel(log)} tone="trace" />
      </dd>
      <dt className="text-trace-muted">Written</dt>
      <dd>{fullTime(log.createdAt)}</dd>
    </dl>
    {log.changes && Object.keys(log.changes).length > 0 ? (
      <Section title="changes">
        <div className="rounded-control bg-trace-raised px-3 py-2.5">
          <ChangeList changes={log.changes} tone="trace" />
        </div>
      </Section>
    ) : null}
    <Section title="before">
      <Json value={log.before} />
    </Section>
    <Section title="after">
      <Json value={log.after} />
    </Section>
    <Section title="actorContext">
      <Json value={log.actorContext} />
    </Section>
    <Section title="entityContext">
      <Json value={log.entityContext} />
    </Section>
    <Section title="aggregateContext">
      <Json value={log.aggregateContext} />
    </Section>
    <Section title="requestContext">
      <Json value={log.requestContext} />
    </Section>
  </div>
);

export const AuditPage = () => {
  const { people } = useActor();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AuditFilter>({});
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const [resetting, setResetting] = useState(false);
  const { data: logs } = useQuery({
    queryKey: ['audit', 'table', filter],
    queryFn: () => api.auditLogs({ ...filter, limit: 200 }),
    refetchInterval: 4000,
  });

  const set = (key: keyof AuditFilter) => (value: string) =>
    setFilter((current) => ({ ...current, [key]: value === '' ? undefined : value }));

  const reset = async () => {
    setResetting(true);
    try {
      await api.resetDemo();
      await queryClient.invalidateQueries();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-sheet bg-surface">
      <header className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="mt-1 max-w-[64ch] text-sm text-ink-muted">
            The same table the activity feeds read, shown raw: one row per aggregate a write belongs to, with its before
            and after state, the field diff, and the context enrichers added.
          </p>
        </div>
        <Button onClick={reset} disabled={resetting}>
          <RotateCcw size={14} />
          {resetting ? 'Resetting…' : 'Reset demo data'}
        </Button>
      </header>

      <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
        <label className="sr-only" htmlFor="filter-aggregate">
          Aggregate
        </label>
        <select
          id="filter-aggregate"
          className={selectClass}
          value={filter.aggregateType ?? ''}
          onChange={(event) => set('aggregateType')(event.target.value)}
        >
          <option value="">Every aggregate</option>
          {AGGREGATE_TYPES.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="filter-action">
          Action
        </label>
        <select
          id="filter-action"
          className={selectClass}
          value={filter.action ?? ''}
          onChange={(event) => set('action')(event.target.value)}
        >
          <option value="">Every action</option>
          {ACTIONS.map((action) => (
            <option key={action}>{action}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="filter-actor">
          Actor
        </label>
        <select
          id="filter-actor"
          className={selectClass}
          value={filter.actorId ?? ''}
          onChange={(event) => set('actorId')(event.target.value)}
        >
          <option value="">Everyone</option>
          <option value="demo-seed">Demo seed</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        <span className="label ml-auto self-center text-sm text-ink-muted">
          {logs ? plural(logs.length, 'row') : 'Loading…'}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs text-ink-muted">
            <tr className="border-b border-line">
              <th className="px-5 py-2 font-medium">Time</th>
              <th className="px-2 py-2 font-medium">Actor</th>
              <th className="px-2 py-2 font-medium">Action</th>
              <th className="px-2 py-2 font-medium">Entity</th>
              <th className="px-2 py-2 font-medium">Aggregate</th>
              <th className="px-5 py-2 font-medium">Request</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {logs?.map((log) => (
              <tr key={log.id} className="cursor-pointer hover:bg-paper" onClick={() => setSelected(log)}>
                <td className="px-5 py-2 whitespace-nowrap text-ink-muted">
                  <time dateTime={log.createdAt}>{clockTime(log.createdAt)}</time>
                </td>
                <td className="px-2 py-2 whitespace-nowrap">{actorName(log)}</td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    className="flex items-center gap-2"
                    onClick={() => setSelected(log)}
                    aria-label={`Open ${log.action} row`}
                  >
                    <ActionMark action={log.action} tone="light" />
                    {log.action}
                  </button>
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  {log.entityType} <code className="text-ink-muted">{shortId(log.entityId)}</code>
                </td>
                <td className="max-w-[220px] px-2 py-2">
                  <AggregateChip type={log.aggregateType} label={aggregateLabel(log)} tone="light" />
                </td>
                <td className="px-5 py-2 whitespace-nowrap">
                  <code className="text-ink-muted">
                    {log.requestContext?.method} {log.requestContext?.path}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs?.length === 0 ? (
          <p className="px-5 py-10 text-center text-ink-muted">No rows match these filters.</p>
        ) : null}
      </div>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={
          selected ? (
            <>
              <h2 className="text-lg font-semibold">Audit row</h2>
              <code className="text-trace-muted">{selected.id}</code>
            </>
          ) : null
        }
      >
        {selected ? <RowDetail log={selected} /> : null}
      </Drawer>
    </div>
  );
};
