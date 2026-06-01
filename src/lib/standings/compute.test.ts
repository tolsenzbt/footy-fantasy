import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── Crypto mock (for computeStandings tiebreak reuse test) ────────────────────
const { mockRandomInt } = vi.hoisted(() => ({ mockRandomInt: vi.fn() }));
vi.mock("crypto", () => ({ randomInt: mockRandomInt }));

// ── DB mock ───────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));
vi.mock("@/db", () => ({ db: mockDb }));

// Fluent select-chain mock
function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  };
  for (const m of ["from", "where", "orderBy"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

import {
  rankGroupManagers,
  computeStandings,
  type ManagerGroupStats,
  type H2HMatchResult,
} from "./compute";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager(
  managerId: string,
  pointsFor: number,
  overrides: Partial<ManagerGroupStats> = {},
): ManagerGroupStats {
  return {
    managerId,
    groupLetter: "A",
    wins: 0,
    losses: 0,
    draws: 0,
    pointsFor,
    pointsAgainst: 0,
    highestSingleScore: overrides.highestSingleScore ?? pointsFor,
    randomTiebreak: overrides.randomTiebreak ?? 500,
    ...overrides,
  };
}

function h2h(
  homeManagerId: string,
  awayManagerId: string,
  homeScore: number,
  awayScore: number,
): H2HMatchResult {
  return { homeManagerId, awayManagerId, homeScore, awayScore };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("rankGroupManagers", () => {
  it("sorts by pointsFor DESC when no ties", () => {
    const managers = [
      makeManager("C", 50),
      makeManager("A", 100),
      makeManager("B", 75),
    ];
    const ranked = rankGroupManagers(managers, []);
    expect(ranked.map((m) => m.managerId)).toEqual(["A", "B", "C"]);
  });

  it("2-way H2H winner separates tied managers", () => {
    const managers = [makeManager("A", 100), makeManager("B", 100)];
    const results = [h2h("A", "B", 60, 50)]; // A beat B
    const ranked = rankGroupManagers(managers, results);
    expect(ranked.map((m) => m.managerId)).toEqual(["A", "B"]);
  });

  it("2-way H2H away win separates correctly", () => {
    const managers = [makeManager("A", 100), makeManager("B", 100)];
    const results = [h2h("A", "B", 50, 60)]; // B beat A
    const ranked = rankGroupManagers(managers, results);
    expect(ranked.map((m) => m.managerId)).toEqual(["B", "A"]);
  });

  it("2-way H2H draw falls to highestSingleScore", () => {
    const managers = [
      makeManager("A", 100, { highestSingleScore: 40 }),
      makeManager("B", 100, { highestSingleScore: 50 }),
    ];
    const results = [h2h("A", "B", 50, 50)]; // draw
    const ranked = rankGroupManagers(managers, results);
    // B has higher highestSingleScore
    expect(ranked.map((m) => m.managerId)).toEqual(["B", "A"]);
  });

  it("3-way tie: H2H mini-table fully separates A>B>C", () => {
    // A beat B, A beat C, B beat C → A: 2W, B: 1W1L, C: 0W2L
    const managers = [
      makeManager("A", 100),
      makeManager("B", 100),
      makeManager("C", 100),
    ];
    const results = [
      h2h("A", "B", 60, 50), // A beats B
      h2h("A", "C", 60, 40), // A beats C
      h2h("B", "C", 55, 45), // B beats C
    ];
    const ranked = rankGroupManagers(managers, results);
    expect(ranked.map((m) => m.managerId)).toEqual(["A", "B", "C"]);
  });

  it("3-way tie: H2H partial break — A breaks out, B and C re-ranked by highestSingleScore", () => {
    // A beat B, A beat C, B drew C → A: 2W, B: 1W1D, C: 1D1L
    // Wait: B drew C means B: 0W, 1D, 0L in H2H; C: 0W, 1D, 0L in H2H after A excluded
    // Actually after excluding A from the tie group, B vs C mini-table: draw
    // So B and C have same W/D in H2H → recurse → highestSingleScore
    const managers = [
      makeManager("A", 100, { highestSingleScore: 40 }),
      makeManager("B", 100, { highestSingleScore: 60 }),
      makeManager("C", 100, { highestSingleScore: 50 }),
    ];
    const results = [
      h2h("A", "B", 60, 50), // A beats B
      h2h("A", "C", 55, 40), // A beats C
      h2h("B", "C", 50, 50), // B drew C
    ];
    const ranked = rankGroupManagers(managers, results);
    // A has 2 wins → 1st
    // B and C tied in H2H (draw) → highestSingleScore: B=60 > C=50 → B 2nd, C 3rd
    expect(ranked.map((m) => m.managerId)).toEqual(["A", "B", "C"]);
  });

  it("4-way all equal falls to randomTiebreak ASC", () => {
    const managers = [
      makeManager("A", 100, { highestSingleScore: 40, randomTiebreak: 400 }),
      makeManager("B", 100, { highestSingleScore: 40, randomTiebreak: 100 }),
      makeManager("C", 100, { highestSingleScore: 40, randomTiebreak: 300 }),
      makeManager("D", 100, { highestSingleScore: 40, randomTiebreak: 200 }),
    ];
    // All H2H draws
    const results = [
      h2h("A", "B", 50, 50),
      h2h("A", "C", 50, 50),
      h2h("A", "D", 50, 50),
      h2h("B", "C", 50, 50),
      h2h("B", "D", 50, 50),
      h2h("C", "D", 50, 50),
    ];
    const ranked = rankGroupManagers(managers, results);
    // All tied everywhere → randomTiebreak ASC
    expect(ranked.map((m) => m.managerId)).toEqual(["B", "D", "C", "A"]);
  });

  it("cross-group matches (12-team) — managers only ranked within their own group", () => {
    // In a 12-team league some matchups cross groups. Those managers still appear
    // in their own group table; cross-group H2H results are irrelevant for group standings.
    // The function itself is group-local — caller passes only same-group managers.
    const managers = [
      makeManager("A", 90, { groupLetter: "A" }),
      makeManager("B", 80, { groupLetter: "A" }),
      makeManager("C", 70, { groupLetter: "A" }),
    ];
    // Include a cross-group result that should be ignored (D is from group B)
    const results = [
      h2h("A", "B", 60, 50), // same-group
      h2h("B", "D", 55, 45), // cross-group — D not in managers list
    ];
    const ranked = rankGroupManagers(managers, results);
    // PF descending: A > B > C
    expect(ranked.map((m) => m.managerId)).toEqual(["A", "B", "C"]);
  });

  describe("computeStandings — randomTiebreak reuse", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("reuses existing randomTiebreak on recompute", async () => {
      const LEAGUE_ID = "league-uuid";
      const MANAGER_ID = "mgr-uuid";
      const EXISTING_TIEBREAK = 42_000_000;

      // Set up mocks: rounds, matchups, slots, existing standings
      mockDb.select
        // 1. Load group-stage rounds
        .mockReturnValueOnce(sel([{ id: "round-md1", round: "group_md1" }]))
        // 2. Load resolved matchups (none for simplicity — manager has 0 points)
        .mockReturnValueOnce(sel([]))
        // 3. Load schedule_slots
        .mockReturnValueOnce(sel([{ managerId: MANAGER_ID, groupLetter: "A" }]))
        // 4. Load existing standings (has tiebreak)
        .mockReturnValueOnce(
          sel([{ managerId: MANAGER_ID, randomTiebreak: EXISTING_TIEBREAK }]),
        );

      // mockRandomInt should NOT be called since tiebreak already exists
      mockRandomInt.mockReturnValue(99_999_999);

      // transaction mock that captures the upsert values
      let capturedValues: unknown = null;
      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockImplementation((opts: { set: unknown }) => {
                capturedValues = opts.set;
                return Promise.resolve();
              }),
            }),
          }),
        };
        await fn(tx);
      });

      // With no matchup rows, the stats map will be empty → no groups → no DB writes
      // We need at least one matchup to generate stats. Let's use a matchup so manager appears.
      // Re-configure to return one resolved matchup
      mockDb.select
        .mockReset()
        .mockReturnValueOnce(sel([{ id: "round-md1", round: "group_md1" }]))
        .mockReturnValueOnce(
          sel([
            {
              id: "matchup-1",
              homeManagerId: MANAGER_ID,
              awayManagerId: "mgr-b",
              homeScore: "80.00",
              awayScore: "60.00",
              fantasyRoundId: "round-md1",
            },
          ]),
        )
        .mockReturnValueOnce(sel([{ managerId: MANAGER_ID, groupLetter: "A" }, { managerId: "mgr-b", groupLetter: "B" }]))
        .mockReturnValueOnce(
          sel([
            { managerId: MANAGER_ID, randomTiebreak: EXISTING_TIEBREAK },
            { managerId: "mgr-b", randomTiebreak: 77_000_000 },
          ]),
        );

      await computeStandings(LEAGUE_ID);

      // randomInt should NOT have been called since tiebreak already exists for MANAGER_ID
      expect(mockRandomInt).not.toHaveBeenCalled();
    });
  });
});
