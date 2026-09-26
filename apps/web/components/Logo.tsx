export function Logo({ className = '' }: { className?: string }) {
  return <svg className={`logo-mark ${className}`} viewBox="0 0 100 100" fill="none" role="img" aria-label="polyhedge">
    <g stroke="currentColor" strokeWidth="10"><path d="M5 40V5H40" /><path d="M95 60V95H60" /></g>
    <path d="M26 50H74" stroke="var(--action)" strokeWidth="10" />
  </svg>;
}
