import { cn } from "@/lib/utils";

interface LivePillProps {
  label?: string;
  className?: string;
}

export function LivePill({ label = "LIVE", className }: LivePillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
        "text-xs font-semibold tracking-wider text-[var(--live)]",
        "border border-[var(--live)]/30 bg-[var(--live)]/10",
        className
      )}
    >
      <span
        className="size-1.5 rounded-full bg-[var(--live)] animate-live-pulse"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
