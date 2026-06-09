import { cn } from "@/lib/utils";

interface ScoreCellProps {
  value: string | number | null;
  /** Highlight color: 'win' | 'loss' | 'neutral' */
  variant?: "win" | "loss" | "neutral";
  className?: string;
}

const variantStyles = {
  win: "text-[var(--win)]",
  loss: "text-[var(--loss)]",
  neutral: "text-foreground",
};

export function ScoreCell({
  value,
  variant = "neutral",
  className,
}: ScoreCellProps) {
  return (
    <span
      className={cn(
        "tabular-nums font-semibold leading-none",
        variantStyles[variant],
        className
      )}
    >
      {value ?? "—"}
    </span>
  );
}
