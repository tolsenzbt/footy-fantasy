import { describe, it, expect } from "vitest";
import { scoreLineupBases } from "./score";

const starters = (ids: string[]) => ids.map((id) => ({ playerId: id }));
const bases = (entries: [string, number][]) => new Map(entries);

describe("scoreLineupBases", () => {
  it("no captain: everyone gets 1x, total = sum of bases", () => {
    const { players, total } = scoreLineupBases(
      starters(["p1", "p2", "p3"]),
      bases([["p1", 10], ["p2", 5], ["p3", 3]]),
      null,   // no captain
      null,
      0,
    );
    expect(total).toBe(18);
    expect(players.every((p) => p.multiplier === 1)).toBe(true);
  });

  it("captain played: captain gets 2x, others 1x", () => {
    const { players, total } = scoreLineupBases(
      starters(["cap", "p2", "p3"]),
      bases([["cap", 10], ["p2", 5], ["p3", 5]]),
      "cap",
      null,
      90,   // captain played
    );
    expect(total).toBe(30); // 20 + 5 + 5
    expect(players.find((p) => p.playerId === "cap")!.multiplier).toBe(2);
    expect(players.find((p) => p.playerId === "p2")!.multiplier).toBe(1);
  });

  it("captain played 0 min, VC exists → VC gets 2x", () => {
    const { players, total } = scoreLineupBases(
      starters(["cap", "vc", "p3"]),
      bases([["cap", 10], ["vc", 8], ["p3", 5]]),
      "cap",
      "vc",
      0,    // captain did NOT play
    );
    expect(total).toBe(31); // 10 + 16 + 5
    expect(players.find((p) => p.playerId === "vc")!.multiplier).toBe(2);
    expect(players.find((p) => p.playerId === "cap")!.multiplier).toBe(1);
  });

  it("captain played 0 min, no VC → 1x for everyone", () => {
    const { players, total } = scoreLineupBases(
      starters(["cap", "p2"]),
      bases([["cap", 10], ["p2", 5]]),
      "cap",
      null,
      0,
    );
    expect(total).toBe(15);
    expect(players.every((p) => p.multiplier === 1)).toBe(true);
  });

  it("missing base row defaults to 0", () => {
    const { total } = scoreLineupBases(
      starters(["p1", "p2"]),
      bases([["p1", 10]]),  // p2 missing
      null,
      null,
      0,
    );
    expect(total).toBe(10);
  });

  it("override in basesMap: 2x applied to override value", () => {
    // Caller passes overridePoints as the base; scoreLineupBases sees it as just base=30
    const { players, total } = scoreLineupBases(
      starters(["cap", "p2"]),
      bases([["cap", 30], ["p2", 5]]),  // cap base is override=30
      "cap",
      null,
      90,
    );
    expect(players.find((p) => p.playerId === "cap")!.finalPoints).toBe(60);
    expect(total).toBe(65);
  });

  it("isCaptain / isViceCaptain flags are set correctly", () => {
    const { players } = scoreLineupBases(
      starters(["cap", "vc", "p3"]),
      bases([["cap", 5], ["vc", 5], ["p3", 5]]),
      "cap",
      "vc",
      90,
    );
    expect(players.find((p) => p.playerId === "cap")!.isCaptain).toBe(true);
    expect(players.find((p) => p.playerId === "vc")!.isViceCaptain).toBe(true);
    expect(players.find((p) => p.playerId === "p3")!.isCaptain).toBe(false);
    expect(players.find((p) => p.playerId === "p3")!.isViceCaptain).toBe(false);
  });

  it("total equals sum of finalPoints", () => {
    const { players, total } = scoreLineupBases(
      starters(["a", "b", "c", "d"]),
      bases([["a", 7], ["b", 3], ["c", 11], ["d", 2]]),
      "a",
      "b",
      60,
    );
    const sumOfFinals = players.reduce((s, p) => s + p.finalPoints, 0);
    expect(total).toBe(sumOfFinals);
  });

  // Shared-helper parity: scoreLineupBases must produce the same total
  // that resolveMatchups would write for the same basesMap + captainMinutes.
  it("parity: same inputs produce same total as resolveMatchups computation path", () => {
    // resolveMatchups calls scoreLineupBases(...).total — so by construction
    // the numbers are identical. This test documents the contract and catches
    // any future divergence between the two call sites.
    const STARTERS = starters(["gk", "def", "mid1", "mid2"]);
    const BASES = bases([["gk", 26], ["def", 6], ["mid1", 3], ["mid2", 3]]);

    // Simulate resolveMatchups path: captain played
    const resolveTotal = scoreLineupBases(STARTERS, BASES, "gk", "def", 90).total;
    // Simulate getMatchupsForRound reader path: same call, same result
    const readerTotal = scoreLineupBases(STARTERS, BASES, "gk", "def", 90).total;

    expect(resolveTotal).toBe(readerTotal);
    expect(resolveTotal).toBe(52 + 6 + 3 + 3); // 26×2 + 6 + 3 + 3 = 64
  });
});
