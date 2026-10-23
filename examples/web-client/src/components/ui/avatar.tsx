import { cx } from '@/lib/cx';

const initials = (name: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const Avatar = ({ name, size = 'md' }: { name: string | null; size?: 'sm' | 'md' | 'lg' }) => (
  <span
    aria-hidden
    className={cx(
      'inline-grid shrink-0 place-items-center rounded-full bg-agg-user-tint font-semibold text-agg-user ring-1 ring-agg-user/30',
      size === 'sm' && 'size-6 text-[10px]',
      size === 'md' && 'size-10 text-sm',
      size === 'lg' && 'size-16 text-xl',
    )}
  >
    {initials(name)}
  </span>
);
