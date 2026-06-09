import { cn } from "@/lib/utils";

type Position = "GK" | "DEF" | "MID" | "FWD";

const positionStyles: Record<Position, string> = {
  GK: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  DEF: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  MID: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  FWD: "bg-red-500/15 text-red-400 border-red-500/30",
};

interface PositionBadgeProps {
  position: Position;
  className?: string;
}

export function PositionBadge({ position, className }: PositionBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border px-1.5 py-0.5",
        "text-xs font-semibold leading-none tracking-wide",
        "min-w-[2.5rem]",
        positionStyles[position],
        className
      )}
    >
      {position}
    </span>
  );
}
