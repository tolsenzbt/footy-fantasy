import { cn } from "@/lib/utils";

/** Converts ISO 3166-1 alpha-2 (e.g. "DE") to a flag emoji via regional indicator chars */
function iso2ToFlagEmoji(iso2: string): string {
  const offset = 0x1f1a5; // 0x1F1E6 - 'A'.charCodeAt(0)
  return iso2
    .toUpperCase()
    .split("")
    .map(c => String.fromCodePoint(offset + c.charCodeAt(0)))
    .join("");
}

// Tag-sequence flags for GB subdivisions (no ISO 3166-1 alpha-2)
const SUBDIVISION_FLAGS: Record<string, string> = {
  ENG: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  SCO: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
};

interface NationChipProps {
  /** Canonical FIFA 3-letter code (e.g. "GER", "USA") — display text */
  fifaCode: string;
  /** ISO 3166-1 alpha-2 (e.g. "DE") — source for flag emoji; null for ENG/SCO */
  isoCode?: string | null;
  /** Full nation name for tooltip */
  name?: string;
  className?: string;
}

export function NationChip({ fifaCode, isoCode, name, className }: NationChipProps) {
  const flag = isoCode
    ? iso2ToFlagEmoji(isoCode)
    : (SUBDIVISION_FLAGS[fifaCode.toUpperCase()] ?? null);

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
      <span>{fifaCode.toUpperCase()}</span>
    </span>
  );
}
