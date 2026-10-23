import { type AggregateKind, aggregateKind } from '@/lib/audit';
import { cx } from '@/lib/cx';

export type Tone = 'light' | 'trace';

type Hue = { dot: Record<Tone, string>; text: Record<Tone, string>; line: string };

const hues: Record<AggregateKind, Hue> = {
  user: {
    dot: { light: 'bg-agg-user', trace: 'bg-agg-user-glow' },
    text: { light: 'text-agg-user', trace: 'text-agg-user-glow' },
    line: 'border-agg-user bg-agg-user/10',
  },
  post: {
    dot: { light: 'bg-agg-post', trace: 'bg-agg-post-glow' },
    text: { light: 'text-agg-post', trace: 'text-agg-post-glow' },
    line: 'border-agg-post bg-agg-post/10',
  },
  comment: {
    dot: { light: 'bg-agg-comment', trace: 'bg-agg-comment-glow' },
    text: { light: 'text-agg-comment', trace: 'text-agg-comment-glow' },
    line: 'border-agg-comment bg-agg-comment/10',
  },
  tag: {
    dot: { light: 'bg-agg-tag', trace: 'bg-agg-tag-glow' },
    text: { light: 'text-agg-tag', trace: 'text-agg-tag-glow' },
    line: 'border-agg-tag bg-agg-tag/10',
  },
};

export const mutedText = (tone: Tone) => (tone === 'light' ? 'text-ink-muted' : 'text-trace-muted');

export const hueText = (type: string, tone: Tone) => {
  const kind = aggregateKind(type);
  return kind ? hues[kind].text[tone] : tone === 'light' ? 'text-ink' : 'text-trace-ink';
};

/** A highlighted source line that declares an aggregate, in that aggregate's hue */
export const hueLine = (type: string) => {
  const kind = aggregateKind(type);
  return kind ? hues[kind].line : 'border-ink-muted bg-ink/5';
};

export const HueDot = ({ type, tone }: { type: string; tone: Tone }) => {
  const kind = aggregateKind(type);
  return (
    <span
      aria-hidden
      className={cx(
        'inline-block size-2 shrink-0 rounded-full',
        kind ? hues[kind].dot[tone] : tone === 'light' ? 'bg-ink-muted' : 'bg-trace-muted',
      )}
    />
  );
};

type ChipProps = { type: string; label?: string; tone: Tone; className?: string };

export const AggregateChip = ({ type, label, tone, className }: ChipProps) => (
  <span
    className={cx(
      'inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 text-xs',
      tone === 'light' ? 'bg-ink/5' : 'bg-trace-ink/7',
      className,
    )}
  >
    <HueDot type={type} tone={tone} />
    <span className={cx('label font-medium', hueText(type, tone))}>{type}</span>
    {label ? <span className={cx('truncate', mutedText(tone))}>{label}</span> : null}
  </span>
);
