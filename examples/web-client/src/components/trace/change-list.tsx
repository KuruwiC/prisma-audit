import { Lock } from 'lucide-react';
import type { Change } from '@/lib/api';
import { isRedacted } from '@/lib/audit';
import { cx } from '@/lib/cx';
import { mutedText, type Tone } from '../ui/aggregate-chip';

const show = (value: unknown) => JSON.stringify(value) ?? 'null';

const Value = ({ value, tone, struck }: { value: unknown; tone: Tone; struck?: boolean }) =>
  isRedacted(value) ? (
    <span
      className={cx(
        'label inline-flex items-center gap-1 rounded-chip px-1.5',
        tone === 'light' ? 'bg-ink/6 text-ink' : 'bg-trace-ink/10 text-trace-ink',
      )}
    >
      <Lock size={11} aria-hidden /> redacted
    </span>
  ) : (
    <span className={cx('break-all', struck && 'line-through decoration-1', struck ? mutedText(tone) : undefined)}>
      {show(value)}
    </span>
  );

export const ChangeList = ({ changes, tone }: { changes: Record<string, Change>; tone: Tone }) => {
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
      {entries.map(([field, change]) => (
        <div key={field} className="contents">
          <dt className={mutedText(tone)}>{field}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <Value value={change.old} tone={tone} struck />
            <span aria-hidden className={mutedText(tone)}>
              ⟶
            </span>
            <span className="sr-only">becomes</span>
            <Value value={change.new} tone={tone} />
          </dd>
        </div>
      ))}
    </dl>
  );
};
