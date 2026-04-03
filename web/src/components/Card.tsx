import { clsx } from 'clsx';

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={clsx('rounded-xl bg-[var(--color-bg-card)] border border-[var(--color-border)] p-5', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-3">{children}</h3>;
}

export function StatValue({ value, label, color }: { value: string | number; label: string; color?: string }) {
  return (
    <div>
      <div className={clsx('text-2xl font-bold', color || 'text-[var(--color-text)]')}>{value}</div>
      <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">{label}</div>
    </div>
  );
}
