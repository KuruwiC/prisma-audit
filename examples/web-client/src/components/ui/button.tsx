import type { ButtonHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';

type Variant = 'primary' | 'quiet' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-surface hover:bg-ink/88 disabled:bg-ink/40',
  quiet: 'text-ink-muted hover:bg-ink/6 hover:text-ink disabled:text-ink-muted/50',
  danger: 'text-danger hover:bg-danger/8',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' };

export const Button = ({ variant = 'quiet', size = 'md', className, type = 'button', ...props }: ButtonProps) => (
  <button
    type={type}
    className={cx(
      'label inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors disabled:cursor-not-allowed',
      size === 'md' ? 'h-9 px-3.5 text-sm' : 'h-7 px-2 text-xs',
      variants[variant],
      className,
    )}
    {...props}
  />
);
