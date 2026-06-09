import { cn } from "@/lib/utils";

const paddingMap = {
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
} as const;

interface PanelProps {
  children: React.ReactNode;
  className?: string;
  padding?: keyof typeof paddingMap;
  /** Use surface-2 background instead of card */
  elevated?: boolean;
}

export function Panel({
  children,
  className,
  padding = "md",
  elevated = false,
}: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border",
        elevated ? "bg-[var(--surface-2)]" : "bg-card",
        paddingMap[padding],
        className
      )}
    >
      {children}
    </div>
  );
}
