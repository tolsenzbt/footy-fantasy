import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
}));

vi.mock("@/db", () => ({ db: mockDb }));

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

import { getBracket } from "./read";

const LEAGUE_ID = "league-uuid";
const QF_ROUND_ID = "qf-round-uuid";
const SF_ROUND_ID = "sf-round-uuid";
const FINAL_ROUND_ID = "final-round-uuid";

beforeEach(() => vi.resetAllMocks());

describe("getBracket", () => {
  it("groups matchups into qf / sf / final buckets", async () => {
    mockDb.select
      // rounds query
      .mockReturnValueOnce(
        sel([
          { id: QF_ROUND_ID, round: "qf" },
          { id: SF_ROUND_ID, round: "sf" },
          { id: FINAL_ROUND_ID, round: "final" },
        ]),
      )
      // matchups query
      .mockReturnValueOnce(
        sel([
          {
            id: "qf-1",
            fantasyRoundId: QF_ROUND_ID,
            matchIndex: 1,
            homeManagerId: "m1",
            homeSeedSource: "1A",
            awayManagerId: "m2",
            awaySeedSource: "2B",
            homeScore: "60.00",
            awayScore: "55.00",
            winnerManagerId: "m1",
          },
          {
            id: "sf-1",
            fantasyRoundId: SF_ROUND_ID,
            matchIndex: 1,
            homeManagerId: null,
            homeSeedSource: "winner_qf_1",
            awayManagerId: null,
            awaySeedSource: "winner_qf_2",
            homeScore: null,
            awayScore: null,
            winnerManagerId: null,
          },
          {
            id: "final-1",
            fantasyRoundId: FINAL_ROUND_ID,
            matchIndex: 1,
            homeManagerId: null,
            homeSeedSource: "winner_sf_1",
            awayManagerId: null,
            awaySeedSource: "winner_sf_2",
            homeScore: null,
            awayScore: null,
            winnerManagerId: null,
          },
        ]),
      );

    const result = await getBracket(LEAGUE_ID);

    expect(result.qf).toHaveLength(1);
    expect(result.sf).toHaveLength(1);
    expect(result.final).toHaveLength(1);

    expect(result.qf[0].matchupId).toBe("qf-1");
    expect(result.qf[0].homeManagerId).toBe("m1");
    expect(result.qf[0].winnerManagerId).toBe("m1");

    expect(result.sf[0].homeManagerId).toBeNull();
    expect(result.sf[0].homeSeedSource).toBe("winner_qf_1");
  });

  it("marks isBye = true for awaySeedSource='BYE' rows", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      .mockReturnValueOnce(
        sel([
          {
            id: "qf-bye",
            fantasyRoundId: QF_ROUND_ID,
            matchIndex: 3,
            homeManagerId: "m1a",
            homeSeedSource: "1A",
            awayManagerId: null,
            awaySeedSource: "BYE",
            homeScore: null,
            awayScore: null,
            winnerManagerId: "m1a",
          },
        ]),
      );

    const result = await getBracket(LEAGUE_ID);

    expect(result.qf[0].isBye).toBe(true);
    expect(result.qf[0].winnerManagerId).toBe("m1a");
  });

  it("returns empty arrays for rounds with no matchups", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      .mockReturnValueOnce(sel([]));

    const result = await getBracket(LEAGUE_ID);

    expect(result.qf).toHaveLength(0);
    expect(result.sf).toHaveLength(0);
    expect(result.final).toHaveLength(0);
  });

  it("sorts each round's matchups by matchIndex ascending", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      .mockReturnValueOnce(
        sel([
          { id: "qf-3", fantasyRoundId: QF_ROUND_ID, matchIndex: 3, homeManagerId: null, homeSeedSource: "1A", awayManagerId: null, awaySeedSource: "BYE", homeScore: null, awayScore: null, winnerManagerId: null },
          { id: "qf-1", fantasyRoundId: QF_ROUND_ID, matchIndex: 1, homeManagerId: null, homeSeedSource: "2A", awayManagerId: null, awaySeedSource: "3B", homeScore: null, awayScore: null, winnerManagerId: null },
          { id: "qf-4", fantasyRoundId: QF_ROUND_ID, matchIndex: 4, homeManagerId: null, homeSeedSource: "1B", awayManagerId: null, awaySeedSource: "BYE", homeScore: null, awayScore: null, winnerManagerId: null },
          { id: "qf-2", fantasyRoundId: QF_ROUND_ID, matchIndex: 2, homeManagerId: null, homeSeedSource: "2B", awayManagerId: null, awaySeedSource: "3A", homeScore: null, awayScore: null, winnerManagerId: null },
        ]),
      );

    const result = await getBracket(LEAGUE_ID);

    expect(result.qf.map((m) => m.matchIndex)).toEqual([1, 2, 3, 4]);
    expect(result.qf[0].matchupId).toBe("qf-1");
    expect(result.qf[3].matchupId).toBe("qf-4");
  });

  it("returns all three empty buckets when no rounds exist", async () => {
    mockDb.select.mockReturnValueOnce(sel([]));

    const result = await getBracket(LEAGUE_ID);

    expect(result).toEqual({ qf: [], sf: [], final: [] });
  });
});
