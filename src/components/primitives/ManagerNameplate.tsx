import { cn } from "@/lib/utils";

const sizeMap = {
  sm: { avatar: "size-7 text-xs", text: "text-sm" },
  md: { avatar: "size-9 text-sm", text: "text-base" },
  lg: { avatar: "size-11 text-base", text: "text-lg" },
} as const;

interface ManagerNameplateProps {
  displayName: string;
  avatarUrl?: string;
  size?: keyof typeof sizeMap;
  className?: string;
}

export function ManagerNameplate({
  displayName,
  avatarUrl,
  size = "md",
  className,
}: ManagerNameplateProps) {
  const { avatar, text } = sizeMap[size];
  const initials = displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={displayName}
          className={cn("rounded-full object-cover border border-border", avatar)}
        />
      ) : (
        <div
          className={cn(
            "rounded-full border border-border bg-[var(--surface-2)]",
            "flex items-center justify-center font-semibold text-[var(--text-dim)]",
            avatar
          )}
          aria-hidden="true"
        >
          {initials}
        </div>
      )}
      <span className={cn("font-medium text-foreground", text)}>
        {displayName}
      </span>
    </div>
  );
}
