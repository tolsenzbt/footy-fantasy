import { cn } from "@/lib/utils";
import { fifaToFlagEmoji } from "@/lib/nation-flags";

interface NationChipProps {
  /** 3-letter FIFA code (e.g. "GER", "USA") */
  fifaCode: string;
  /** Full nation name (fallback display) */
  name?: string;
  className?: string;
}

export function NationChip({ fifaCode, name, className }: NationChipProps) {
  const flag = fifaToFlagEmoji(fifaCode);
  const displayCode = fifaCode.toUpperCase();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
        "text-xs font-medium text-foreground",
        className
      )}
      title={name ?? fifaCode}
    >
      {flag ? (
        <span aria-hidden="true" className="text-sm leading-none">
          {flag}
        </span>
      ) : null}
      <span>{displayCode}</span>
    </span>
  );
}
