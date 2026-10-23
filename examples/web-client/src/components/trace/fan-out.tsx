import { FileCode2 } from 'lucide-react';
import { aggregateLabel, type Mutation, prismaCall, shortId } from '@/lib/audit';
import { cx } from '@/lib/cx';
import { Link } from '@/lib/router';
import { ActionMark } from '../ui/action-mark';
import { HueDot, hueText, mutedText, type Tone } from '../ui/aggregate-chip';
import { ChangeList } from './change-list';

/** The extension writes one audit row per aggregate branch of a write, each carrying that aggregate's id and context */
export const FanOut = ({ mutation, tone = 'trace' }: { mutation: Mutation; tone?: Tone }) => {
  const first = mutation.projections[0];
  const muted = mutedText(tone);
  const branch = tone === 'light' ? 'border-line' : 'border-trace-line';

  return (
    <div>
      <div className="flex items-center gap-2">
        <ActionMark action={mutation.action} tone={tone} />
        <span className={cx('label text-sm font-semibold', hueText(mutation.entityType, tone))}>
          {mutation.entityType}
        </span>
        <code className={cx('truncate', muted)} title={mutation.entityId}>
          {shortId(mutation.entityId)}
        </code>
        <span className="label ml-auto flex items-center gap-1.5">
          <code className={cx('hidden sm:block', muted)}>{prismaCall(mutation.entityType, mutation.action)}</code>
          <Link
            to={{ name: 'config', section: mutation.entityType }}
            title={`Why these aggregates: the ${mutation.entityType} entry of audit.config.ts`}
            aria-label={`See how ${mutation.entityType} is mapped`}
            className={cx(
              'rounded-chip p-0.5',
              tone === 'light' ? 'text-ink-muted hover:text-ink' : 'text-trace-muted hover:text-trace-ink',
            )}
          >
            <FileCode2 size={14} aria-hidden />
          </Link>
        </span>
      </div>

      {first?.changes && mutation.action === 'update' ? (
        <div className={cx('mt-2 ml-7 rounded-chip px-2.5 py-2', tone === 'light' ? 'bg-paper' : 'bg-trace')}>
          <ChangeList changes={first.changes} tone={tone} />
        </div>
      ) : null}

      <ul className="mt-1.5 ml-2.5" aria-label={`Recorded under ${mutation.projections.length} aggregates`}>
        {mutation.projections.map((log, index) => {
          const last = index === mutation.projections.length - 1;
          return (
            <li key={log.id} className="relative flex items-center gap-2 py-0.5 pl-6 text-xs">
              <span
                aria-hidden
                className={cx('absolute top-0 left-0 h-1/2 w-4 rounded-bl-[6px] border-b border-l', branch)}
              />
              {last ? null : <span aria-hidden className={cx('absolute top-1/2 bottom-0 left-0 border-l', branch)} />}
              <HueDot type={log.aggregateType} tone={tone} />
              <span className={cx('label font-medium', hueText(log.aggregateType, tone))}>{log.aggregateType}</span>
              <span className={cx('truncate', muted)}>{aggregateLabel(log)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
