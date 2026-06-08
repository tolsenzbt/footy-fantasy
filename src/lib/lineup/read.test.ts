import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
}));

vi.mock("@/db", () => ({ db: mockDb }));

// Fluent select-chain mock
function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
    limit: vi.fn().mockReturnValue(terminal),
  };
  for (const m of ["from", "where", "innerJoin"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

import { getLineup } from "./read";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const MANAGER_ID = "manager-uuid";

const MD1_ROUND_ID = "round-md1-uuid";
const MD2_ROUND_ID = "round-md2-uuid";
const LINEUP_ID = "lineup-uuid";

const allRoundsRows = [
  { id: MD1_ROUND_ID, round: "group_md1" },
  { id: MD2_ROUND_ID, round: "group_md2" },
];

const lineupRow = {
  id: LINEUP_ID,
  leagueId: LEAGUE_ID,
  managerId: MANAGER_ID,
  fantasyRoundId: MD1_ROUND_ID,
  formation: "4-4-2",
  captainPlayerId: "p01",
  vcPlayerId: "p02",
  captainLockedAt: null,
  vcLockedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const slotRows = [
  { playerId: "p01", playerName: "Alice", position: "GK",  slotType: "starter", lockedAt: null },
  { playerId: "p02", playerName: "Bob",   position: "DEF", slotType: "starter", lockedAt: null },
];

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getLineup", () => {
  it("returns null when fantasyRoundId not found in league", async () => {
    mockDb.select.mockReturnValueOnce(sel([])); // allRounds → empty
    const result = await getLineup(LEAGUE_ID, MANAGER_ID, "nonexistent-round-id");
    expect(result).toBeNull();
  });

  it("returns lineup when found for the requested round", async () => {
    mockDb.select
      .mockReturnValueOnce(sel(allRoundsRows))  // all rounds
      .mockReturnValueOnce(sel([lineupRow]))     // lineup for md1
      .mockReturnValueOnce(sel(slotRows));       // slots

    const result = await getLineup(LEAGUE_ID, MANAGER_ID, MD1_ROUND_ID);

    expect(result).not.toBeNull();
    expect(result!.lineupId).toBe(LINEUP_ID);
    expect(result!.round).toBe("group_md1");
    expect(result!.isFallback).toBe(false);
    expect(result!.fallbackRound).toBeNull();
    expect(result!.slots).toHaveLength(2);
  });

  it("returns null when no lineup exists for requested round or any prior round", async () => {
    mockDb.select
      .mockReturnValueOnce(sel(allRoundsRows)) // all rounds
      .mockReturnValueOnce(sel([]))            // lineup for md2 → not found
      .mockReturnValueOnce(sel([]));           // lineup for md1 → not found

    const result = await getLineup(LEAGUE_ID, MANAGER_ID, MD2_ROUND_ID);
    expect(result).toBeNull();
  });

  it("falls back to md1 when md2 lineup not set", async () => {
    mockDb.select
      .mockReturnValueOnce(sel(allRoundsRows))  // all rounds
      .mockReturnValueOnce(sel([]))             // lineup for md2 → not found
      .mockReturnValueOnce(sel([{ ...lineupRow, fantasyRoundId: MD1_ROUND_ID }])) // lineup for md1
      .mockReturnValueOnce(sel(slotRows));      // slots

    const result = await getLineup(LEAGUE_ID, MANAGER_ID, MD2_ROUND_ID);

    expect(result).not.toBeNull();
    expect(result!.round).toBe("group_md1");
    expect(result!.isFallback).toBe(true);
    expect(result!.fallbackRound).toBe("group_md1");
  });

  it("returns lineup fields correctly", async () => {
    const captainLockDate = new Date("2026-06-01T09:00:00Z");
    const lockedLineup = { ...lineupRow, captainLockedAt: captainLockDate };

    mockDb.select
      .mockReturnValueOnce(sel(allRoundsRows))
      .mockReturnValueOnce(sel([lockedLineup]))
      .mockReturnValueOnce(sel(slotRows));

    const result = await getLineup(LEAGUE_ID, MANAGER_ID, MD1_ROUND_ID);

    expect(result!.formation).toBe("4-4-2");
    expect(result!.captainPlayerId).toBe("p01");
    expect(result!.vcPlayerId).toBe("p02");
    expect(result!.captainLockedAt).toEqual(captainLockDate);
  });

  it("returns null when requested round doesn't exist in ROUND_ORDER (defensive)", async () => {
    // Return a round name not in ROUND_ORDER
    mockDb.select.mockReturnValueOnce(
      sel([{ id: "some-id", round: "unknown_round" }])
    );
    const result = await getLineup(LEAGUE_ID, MANAGER_ID, "some-id");
    expect(result).toBeNull();
  });
});
