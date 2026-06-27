// Sharp, Swiss-style spinner: a square outline with one open edge, rotating.
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Laden"
      className={`inline-block h-4 w-4 border-2 border-black border-t-transparent animate-spin ${className}`}
    />
  )
}

// Full-cover overlay for a media/content area that is loading or restarting.
export function LoadingOverlay({ label = 'Opstarten…', sub }: { label?: string; sub?: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white/85 text-xs font-bold uppercase tracking-widest text-stone-600">
      <Spinner />
      <span>{label}</span>
      {sub && <span className="text-[10px] font-normal normal-case tracking-normal text-stone-400">{sub}</span>}
    </div>
  )
}
