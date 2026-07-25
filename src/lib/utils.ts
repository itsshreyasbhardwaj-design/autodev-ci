import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Severity } from '@/core/types';

/** Merges class names, resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** CSS custom property driving the severity spine colour. */
export function spineStyle(severity: Severity): React.CSSProperties {
  return { ['--spine-color' as string]: `var(--color-sev-${severity})` };
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-[color:var(--color-sev-critical)]',
  high: 'text-[color:var(--color-sev-high)]',
  medium: 'text-[color:var(--color-sev-medium)]',
  low: 'text-[color:var(--color-sev-low)]',
  info: 'text-[color:var(--color-sev-info)]',
};

export const SEVERITY_BG: Record<Severity, string> = {
  critical: 'bg-[color:var(--color-sev-critical)]/12 text-[color:var(--color-sev-critical)]',
  high: 'bg-[color:var(--color-sev-high)]/12 text-[color:var(--color-sev-high)]',
  medium: 'bg-[color:var(--color-sev-medium)]/12 text-[color:var(--color-sev-medium)]',
  low: 'bg-[color:var(--color-sev-low)]/12 text-[color:var(--color-sev-low)]',
  info: 'bg-[color:var(--color-sev-info)]/12 text-[color:var(--color-sev-info)]',
};

/** Compact relative time, e.g. "4m ago", "3d ago". */
export function relativeTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (Number.isNaN(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w ago`;
  return `${Math.floor(seconds / 2_592_000)}mo ago`;
}

/** Formats a number with thin separators, e.g. 12,480. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function gradeColor(grade: string): string {
  switch (grade) {
    case 'A':
      return 'var(--color-sev-low)';
    case 'B':
      return 'var(--color-sev-info)';
    case 'C':
      return 'var(--color-sev-medium)';
    case 'D':
      return 'var(--color-sev-high)';
    default:
      return 'var(--color-sev-critical)';
  }
}
