import { activityOf } from '@/lib/activity';
import type { RequestGroup } from '@/lib/audit';
import { cx } from '@/lib/cx';
import { plural } from '@/lib/plural';
import type { Rollback } from '@/lib/rollbacks';
import { clockTime } from '@/lib/time';
import { FanOut } from './fan-out';

const RequestLine = ({ method, path }: { method: string; path: string }) => (
  <code className="truncate text-trace-ink">
    <span className="font-semibold">{method}</span> {path}
  </code>
);

export const RequestGroupView = ({ group, fresh }: { group: RequestGroup; fresh: boolean }) => {
  const activity = activityOf(group, { kind: 'everything' });
  const phrase = activity?.phrase;
  return (
    <article className={cx('rounded-control bg-trace-raised px-3.5 py-3', fresh && 'motion-safe:animate-arrive')}>
      <header className="mb-2.5 flex items-baseline gap-2 text-xs">
        <RequestLine method={group.method} path={group.path} />
        <span className="label ml-auto text-trace-muted">{plural(group.rowCount, 'row')}</span>
      </header>
      <p className="mb-2.5 text-sm text-trace-ink">
        {phrase ? (
          <>
            <span className="label-inline font-semibold">{phrase.actor}</span> {phrase.predicate}{' '}
          </>
        ) : null}
        <time dateTime={group.createdAt} className="label text-xs text-trace-muted">
          at {clockTime(group.createdAt)}
        </time>
      </p>
      <div className="space-y-3">
        {(activity?.mutations ?? group.mutations).map((mutation) => (
          <FanOut key={mutation.key} mutation={mutation} />
        ))}
      </div>
    </article>
  );
};

export const RollbackView = ({ rollback }: { rollback: Rollback }) => (
  <article className="motion-safe:animate-collapse rounded-control border border-dashed border-trace-line px-3.5 py-3">
    <header className="mb-1.5 flex items-baseline gap-2 text-xs">
      <RequestLine method={rollback.method} path={rollback.path} />
      <span className="label ml-auto text-trace-muted">0 rows</span>
    </header>
    <p className="text-xs text-trace-muted">
      <span className="label-inline text-trace-ink">{rollback.actor}</span>'s transaction rolled back. Nothing was
      written, including the audit rows.
    </p>
  </article>
);
