import type { ReactNode } from 'react'

// Foundation primitives in the Swiss house style: sharp 2px borders, monospace
// uppercase labels, black/white invert on interaction. Shared across the app so
// every surface reads the same.

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`border-2 border-black p-4 ${className}`}>{children}</div>
}

// Consistent page header: a small eyebrow over a real title, with optional
// right-aligned actions. Gives every page the same hierarchy.
export function PageHeader({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div>
        <p className="text-[10px] uppercase tracking-[0.25em] text-stone-400">{eyebrow}</p>
        <h1 className="text-xl font-bold uppercase tracking-wide leading-none mt-1">{title}</h1>
      </div>
      {right && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </div>
  )
}

export function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <p className="text-xs font-bold uppercase tracking-widest">{title}</p>
      {hint && <p className="text-[11px] text-stone-500 mt-0.5 leading-snug">{hint}</p>}
    </div>
  )
}

// AAN/UIT-style toggle used for motion-gated, debug, trap-speed, etc.
export function Toggle({
  on,
  onChange,
  onLabel = 'AAN',
  offLabel = 'UIT',
}: {
  on: boolean
  onChange: (next: boolean) => void
  onLabel?: string
  offLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={`shrink-0 border-2 border-black px-3 py-1.5 text-xs uppercase tracking-widest transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-1
                  ${on ? 'bg-black text-white' : 'bg-white text-black hover:bg-stone-100'}`}
    >
      {on ? onLabel : offLabel}
    </button>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost'
  type?: 'button' | 'submit'
  className?: string
}) {
  const base =
    'text-xs uppercase tracking-widest px-4 py-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-1'
  const styles =
    variant === 'primary'
      ? 'border-2 border-black font-bold bg-black text-white hover:bg-stone-800'
      : 'border border-stone-300 text-black hover:border-black'
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  )
}
