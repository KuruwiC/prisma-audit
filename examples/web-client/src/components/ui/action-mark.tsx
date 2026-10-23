import type { AuditAction } from '@/lib/api';
import { cx } from '@/lib/cx';
import type { Tone } from './aggregate-chip';

const glyph: Record<AuditAction, string> = { create: '+', update: '~', delete: '−' };

/** create, update and delete told apart by glyph and stroke, never by hue */
export const ActionMark = ({ action, tone }: { action: AuditAction; tone: Tone }) => (
  <span
    role="img"
    aria-label={action}
    title={action}
    className={cx(
      'inline-grid size-5 shrink-0 place-items-center rounded-chip font-mono text-[11px] leading-none font-semibold',
      action === 'create' && (tone === 'light' ? 'bg-ink text-surface' : 'bg-trace-ink text-trace'),
      action === 'update' &&
        (tone === 'light' ? 'border border-ink text-ink' : 'border border-trace-ink text-trace-ink'),
      action === 'delete' &&
        (tone === 'light'
          ? 'border border-dashed border-ink-muted text-ink-muted'
          : 'border border-dashed border-trace-muted text-trace-muted'),
    )}
  >
    {glyph[action]}
  </span>
);
