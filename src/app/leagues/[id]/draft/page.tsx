import { getDraftBoard, type DraftBoardData, type DraftPickDetail } from "@/lib/draft/board";
import { Panel } from "@/components/primitives/Panel";
import { PositionBadge } from "@/components/primitives/PositionBadge";
import { NationChip } from "@/components/primitives/NationChip";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";
import { LivePill } from "@/components/primitives/LivePill";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeRemaining(expiresAt: Date | null, isExpired: boolean): string | null {
  if (!expiresAt) return null;
  if (isExpired) return "Clock expired";
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "Clock expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m remaining`;
}

/** Given round (1-indexed) and col (0-indexed), return pick number */
function pickNumberForCell(round: number, colIndex: number, leagueSize: number): number {
  if (round % 2 === 1) {
    // Odd round: left → right (col 0 picks first)
    return (round - 1) * leagueSize + (colIndex + 1);
  } else {
    // Even round: right → left (col 0 picks last)
    return (round - 1) * leagueSize + (leagueSize - colIndex);
  }
}

// ── Pick cell (shared between grid and feed) ──────────────────────────────────

function PickCell({ pick, isOnClock }: { pick: DraftPickDetail; isOnClock: boolean }) {
  return (
    <div
      className={[
        "flex flex-col gap-0.5 p-1.5 h-full",
        isOnClock ? "bg-primary/10 ring-1 ring-primary ring-inset" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-1 flex-wrap">
        <PositionBadge position={pick.player.position} />
        <NationChip fifaCode={pick.player.nationFifaCode} name={pick.player.nationName} />
      </div>
      <span className="text-[11px] leading-tight text-foreground font-medium line-clamp-2 break-words">
        {pick.player.name}
      </span>
    </div>
  );
}

// ── Empty cell placeholder ───────────────────────────────────────────────────

function EmptyCell({ pickNumber, isOnClock }: { pickNumber: number; isOnClock: boolean }) {
  return (
    <div
      className={[
        "flex items-center justify-center h-full",
        isOnClock
          ? "bg-primary/10 ring-1 ring-primary ring-inset"
          : "bg-transparent",
      ].join(" ")}
    >
      {isOnClock ? (
        <span className="text-[10px] font-semibold text-primary animate-pulse">
          ON CLOCK
        </span>
      ) : (
        <span className="text-[10px] text-border tabular-nums">
          #{pickNumber}
        </span>
      )}
    </div>
  );
}

// ── Desktop grid ─────────────────────────────────────────────────────────────

function DesktopGrid({ board }: { board: DraftBoardData }) {
  // Build a map: pickNumber → pick detail for O(1) lookup
  const pickByNumber = new Map<number, DraftPickDetail>();
  for (const p of board.picks) pickByNumber.set(p.pickNumber, p);

  const onClockPickNum = board.onTheClockManagerId
    ? board.picks.find(p => p.pickNumber === (board.picks.length + 1))?.pickNumber ?? null
    : null;

  // For active drafts, the next pick number is picks.length + 1
  const nextPickNumber =
    board.status === "active" ? board.picks.length + 1 : null;

  return (
    <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
      <table className="border-collapse" style={{ minWidth: `${board.leagueSize * 112 + 80}px` }}>
        <thead>
          <tr className="bg-[var(--surface-2)]">
            {/* Round column header */}
            <th className="sticky left-0 z-10 bg-[var(--surface-2)] w-14 min-w-[3.5rem] px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)] border-b border-r border-border">
              Rd
            </th>
            {board.managers.map((mgr) => (
              <th
                key={mgr.membershipId}
                className="px-1 py-2 border-b border-r border-border last:border-r-0 min-w-[7rem]"
              >
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[10px] text-[var(--text-dim)] tabular-nums">
                    #{mgr.draftPosition}
                  </span>
                  <span className="text-xs font-medium text-foreground truncate max-w-[6.5rem] text-center">
                    {mgr.displayName.split(" ")[0]}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: board.totalRounds }, (_, ri) => {
            const round = ri + 1;
            const isOdd = round % 2 === 1;
            return (
              <tr
                key={round}
                className="hover:bg-[var(--surface-2)]/40 transition-colors"
              >
                {/* Round label + direction arrow */}
                <td className="sticky left-0 z-10 bg-background border-b border-r border-border px-2 py-0 text-center">
                  <div className="flex flex-col items-center leading-tight">
                    <span className="text-xs font-semibold text-foreground tabular-nums">{round}</span>
                    <span className="text-[10px] text-[var(--text-dim)]">{isOdd ? "→" : "←"}</span>
                  </div>
                </td>
                {/* Pick cells */}
                {board.managers.map((mgr) => {
                  const pickNum = pickNumberForCell(round, mgr.draftPosition - 1, board.leagueSize);
                  const pick = pickByNumber.get(pickNum);
                  const isOnClock = nextPickNumber === pickNum;

                  return (
                    <td
                      key={mgr.membershipId}
                      className="border-b border-r border-border last:border-r-0 p-0 align-top"
                      style={{ height: "4.5rem", width: "7rem" }}
                    >
                      {pick ? (
                        <PickCell pick={pick} isOnClock={isOnClock} />
                      ) : (
                        <EmptyCell pickNumber={pickNum} isOnClock={isOnClock} />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Phone pick feed ──────────────────────────────────────────────────────────

function PhoneFeed({ board }: { board: DraftBoardData }) {
  const managerById = new Map(board.managers.map(m => [m.membershipId, m]));
  // Most-recent first
  const reversedPicks = [...board.picks].reverse();
  const timeLeft = formatTimeRemaining(board.expiresAt, board.isExpired);

  return (
    <div className="md:hidden space-y-2">
      {/* On-the-clock banner (active draft only) */}
      {board.status === "active" && board.onTheClockManagerId && (
        <Panel className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <LivePill label="ON THE CLOCK" />
            </div>
            <ManagerNameplate
              displayName={managerById.get(board.onTheClockManagerId)?.displayName ?? "…"}
              size="md"
            />
            {timeLeft && (
              <p className="text-xs text-[var(--text-dim)] mt-1 tabular-nums">{timeLeft}</p>
            )}
          </div>
        </Panel>
      )}

      {/* Completed banner */}
      {board.status === "complete" && (
        <Panel elevated className="text-center py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-dim)]">
            Draft complete · {board.picks.length} picks
          </span>
        </Panel>
      )}

      {/* Pick feed */}
      {reversedPicks.map((pick) => {
        const mgr = managerById.get(pick.managerId);
        return (
          <Panel key={pick.pickNumber} padding="sm">
            <div className="flex items-start gap-3">
              <span className="tabular-nums text-xs text-[var(--text-dim)] w-10 shrink-0 pt-0.5">
                #{pick.pickNumber}
              </span>
              <div className="flex-1 min-w-0 space-y-1">
                {mgr && (
                  <ManagerNameplate displayName={mgr.displayName} size="sm" />
                )}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <PositionBadge position={pick.player.position} />
                  <NationChip fifaCode={pick.player.nationFifaCode} name={pick.player.nationName} />
                  <span className="text-sm text-foreground font-medium">
                    {pick.player.name}
                  </span>
                </div>
              </div>
              <span className="text-[10px] text-[var(--text-dim)] tabular-nums shrink-0">
                R{pick.roundNumber}
              </span>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DraftBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: leagueId } = await params;
  const board = await getDraftBoard(leagueId, "initial");

  if (!board) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Panel className="text-center">
          <p className="text-[var(--text-dim)]">No draft found for this league.</p>
        </Panel>
      </div>
    );
  }

  const timeLeft = formatTimeRemaining(board.expiresAt, board.isExpired);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
        {/* ── Page header ── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Draft Board</h1>
            <p className="text-sm text-[var(--text-dim)] mt-0.5">
              {board.leagueSize} managers · {board.totalRounds} rounds · {board.totalPicks} picks
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {board.status === "active" && <LivePill label="LIVE" />}
            {board.status === "complete" && (
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--win)] border border-[var(--win)]/30 bg-[var(--win)]/10 rounded-full px-3 py-1">
                Complete
              </span>
            )}
            {board.status === "pending" && (
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-dim)] border border-border rounded-full px-3 py-1">
                Pending
              </span>
            )}
            {timeLeft && board.status === "active" && (
              <span className="text-xs text-[var(--text-dim)] tabular-nums">{timeLeft}</span>
            )}
          </div>
        </div>

        {/* ── On-the-clock banner (desktop, active draft) ── */}
        {board.status === "active" && board.onTheClockManagerId && (
          <Panel className="hidden md:flex items-center gap-4">
            <LivePill label="ON THE CLOCK" />
            <ManagerNameplate
              displayName={
                board.managers.find(m => m.membershipId === board.onTheClockManagerId)?.displayName ?? "…"
              }
              size="sm"
            />
            {timeLeft && (
              <span className="text-sm text-[var(--text-dim)] tabular-nums ml-auto">{timeLeft}</span>
            )}
          </Panel>
        )}

        {/* ── Desktop grid (md+) ── */}
        <DesktopGrid board={board} />

        {/* ── Phone feed (below md) ── */}
        <PhoneFeed board={board} />
      </div>
    </div>
  );
}
