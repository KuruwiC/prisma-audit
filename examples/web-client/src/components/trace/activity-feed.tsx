import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { type Activity, type Perspective, toActivities } from '@/lib/activity';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { plural } from '@/lib/plural';
import { fullTime, timeAgo } from '@/lib/time';
import { ActionMark } from '../ui/action-mark';
import { mutedText, type Tone } from '../ui/aggregate-chip';
import { FanOut } from './fan-out';

const FEED_LIMIT = 200;

const filterOf = (perspective: Perspective) =>
  perspective.kind === 'everything' ? {} : { aggregateType: perspective.type, aggregateId: perspective.id };

export const QuerySnippet = ({ perspective, tone }: { perspective: Perspective; tone: Tone }) => (
  <pre
    className={cx(
      'overflow-x-auto rounded-control px-3.5 py-3 leading-relaxed',
      tone === 'light' ? 'bg-ink text-surface/90' : 'bg-trace-raised text-trace-ink',
    )}
  >
    <code>
      {'prisma.auditLog.findMany({\n'}
      {perspective.kind === 'aggregate'
        ? `  where: {\n    aggregateType: '${perspective.type}',\n    aggregateId: '${perspective.id}',\n  },\n`
        : ''}
      {`  orderBy: { createdAt: 'desc' },\n  take: ${FEED_LIMIT},\n})`}
    </code>
  </pre>
);

const ActivityItem = ({ activity, tone }: { activity: Activity; tone: Tone }) => {
  const { phrase } = activity;
  const muted = mutedText(tone);
  return (
    <li className={cx('flex gap-3 py-3.5', phrase.quiet && 'opacity-60')}>
      <ActionMark action={activity.action} tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span>
            <span className="label-inline font-semibold">{phrase.actor}</span> {phrase.predicate}
          </span>
          <time dateTime={activity.at} title={fullTime(activity.at)} className={cx('label text-xs', muted)}>
            {timeAgo(activity.at)}
          </time>
        </p>
        {phrase.quote ? (
          <blockquote
            className={cx(
              'border-l-2 pl-3',
              tone === 'light' ? 'border-line text-ink' : 'border-trace-line text-trace-ink',
            )}
          >
            {phrase.quote}
          </blockquote>
        ) : null}
        {phrase.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Tags">
            {phrase.tags.map((tag) => (
              <li key={tag.name} className={cx('label', tone === 'light' ? 'text-agg-tag' : 'text-agg-tag-glow')}>
                #{tag.name}
                {tag.created ? <span className={cx('pl-1 text-xs', muted)}>new</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {phrase.details.map((detail) => (
          <p key={detail} className={muted}>
            {detail}
          </p>
        ))}
        <details className="group">
          <summary
            className={cx(
              'flex max-w-full cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden',
              muted,
            )}
          >
            {activity.request ? (
              <code className="min-w-0 truncate">
                {activity.request.method} {activity.request.path}
              </code>
            ) : null}
            <span className="label flex items-center gap-0.5">
              {plural(activity.rowCount, 'row')}
              <ChevronRight size={13} aria-hidden className="group-open:rotate-90 motion-safe:transition-transform" />
            </span>
          </summary>
          <div
            className={cx('mt-2 flex flex-col gap-3 rounded-control p-3', tone === 'light' ? 'bg-paper' : 'bg-trace')}
          >
            {activity.mutations.map((mutation) => (
              <FanOut key={mutation.key} mutation={mutation} tone={tone} />
            ))}
          </div>
        </details>
      </div>
    </li>
  );
};

export const ActivityFeed = ({ perspective, tone }: { perspective: Perspective; tone: Tone }) => {
  const filter = filterOf(perspective);
  const { data: logs } = useQuery({
    queryKey: ['audit', 'feed', filter],
    queryFn: () => api.auditLogs({ ...filter, limit: FEED_LIMIT }),
  });
  const activities = logs ? toActivities(logs, perspective) : undefined;
  const muted = mutedText(tone);

  if (!activities) return <p className={cx('text-sm', muted)}>Loading activity…</p>;
  if (activities.length === 0) return <p className={cx('text-sm', muted)}>Nothing has been recorded here yet.</p>;

  return (
    <ol className={cx('divide-y', tone === 'light' ? 'divide-line' : 'divide-trace-line')}>
      {activities.map((activity) => (
        <ActivityItem key={activity.id} activity={activity} tone={tone} />
      ))}
    </ol>
  );
};
