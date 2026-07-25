import { cva, type VariantProps } from 'class-variance-authority';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import type { GateStatus, Severity } from '@/core/types';
import { SEVERITY_BG, cn } from '@/lib/utils';

/**
 * UI primitives.
 *
 * Kept in one file on purpose: there are eight of them, they share the same
 * token vocabulary, and splitting them across eight files would make the
 * design system harder to read, not easier.
 */

// --- Button ---------------------------------------------------------------

const buttonStyles = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-45 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary:
          'bg-[color:var(--color-signal)] text-white hover:bg-[color:var(--color-signal-bright)] shadow-[0_2px_20px_-6px_var(--color-signal)] hover:shadow-[0_4px_28px_-6px_var(--color-signal)]',
        secondary:
          'bg-[color:var(--color-ink-800)] text-[color:var(--color-fg)] border border-[color:var(--color-line)] hover:border-[color:var(--color-line-bright)] hover:bg-[color:var(--color-ink-700)]',
        ghost:
          'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-ink-800)]',
        danger:
          'bg-[color:var(--color-sev-critical)]/15 text-[color:var(--color-sev-critical)] border border-[color:var(--color-sev-critical)]/30 hover:bg-[color:var(--color-sev-critical)]/25',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-[15px]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonStyles>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

export type ButtonLinkProps = ComponentProps<typeof Link> & VariantProps<typeof buttonStyles>;

export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

// --- Card -----------------------------------------------------------------

export function Card({
  className,
  children,
  ...props
}: ComponentProps<'div'> & { children: ReactNode }) {
  return (
    <div className={cn('glass p-5', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  eyebrow,
  action,
}: {
  title: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        {eyebrow ? <p className="label mb-1.5">{eyebrow}</p> : null}
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      </div>
      {action}
    </div>
  );
}

// --- Badge ----------------------------------------------------------------

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider',
        SEVERITY_BG[severity],
      )}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: `var(--color-sev-${severity})` }}
        aria-hidden
      />
      {count !== undefined ? `${count} ` : ''}
      {severity}
    </span>
  );
}

const GATE_STYLES: Record<GateStatus, { label: string; className: string }> = {
  passed: {
    label: 'passed',
    className: 'text-[color:var(--color-add)] bg-[color:var(--color-add)]/12',
  },
  warning: {
    label: 'warning',
    className: 'text-[color:var(--color-sev-medium)] bg-[color:var(--color-sev-medium)]/12',
  },
  failed: {
    label: 'failed',
    className: 'text-[color:var(--color-sev-critical)] bg-[color:var(--color-sev-critical)]/12',
  },
  skipped: { label: 'skipped', className: 'text-[color:var(--color-fg-subtle)] bg-white/5' },
};

export function GateBadge({ status }: { status: GateStatus }) {
  const style = GATE_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex rounded-md px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

// --- Stat -----------------------------------------------------------------

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      <p
        className="mt-1.5 font-display text-3xl font-semibold tracking-tight tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-[13px] text-[color:var(--color-fg-muted)]">{hint}</p> : null}
    </div>
  );
}

// --- Empty state ----------------------------------------------------------

/**
 * Empty states are an invitation to act, not an apology. Every one of these
 * names the next step rather than saying "nothing here yet".
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-[color:var(--color-fg-subtle)]">{icon}</div> : null}
      <h3 className="font-display text-lg">{title}</h3>
      <p className="max-w-sm text-pretty text-sm text-[color:var(--color-fg-muted)]">
        {description}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// --- Score ring -----------------------------------------------------------

/**
 * Circular score indicator. Uses a stroke-dashoffset arc rather than a
 * conic-gradient so the track and the value can carry different colours and
 * the whole thing stays crisp at any size.
 */
export function ScoreRing({
  score,
  size = 92,
  label,
  color,
}: {
  score: number;
  size?: number;
  label?: string;
  color?: string;
}) {
  const stroke = size / 11;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);

  const resolved =
    color ??
    (score >= 90
      ? 'var(--color-sev-low)'
      : score >= 75
        ? 'var(--color-sev-info)'
        : score >= 60
          ? 'var(--color-sev-medium)'
          : 'var(--color-sev-critical)');

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label ?? 'Score'}: ${score} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-ink-700)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={resolved}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 900ms var(--ease-out-expo)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-display font-semibold tabular-nums"
          style={{ fontSize: size / 3.4, color: resolved }}
        >
          {score}
        </span>
        {label ? <span className="label mt-0.5 text-[9px]">{label}</span> : null}
      </div>
    </div>
  );
}
