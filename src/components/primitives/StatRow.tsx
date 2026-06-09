import { cn } from "@/lib/utils";

interface StatRowProps {
  label: string;
  value: string | number;
  className?: string;
}

export function StatRow({ label, value, className }: StatRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-1.5", className)}>
      <span className="text-sm text-[var(--text-dim)]">{label}</span>
      <span className="tabular-nums text-sm font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}
