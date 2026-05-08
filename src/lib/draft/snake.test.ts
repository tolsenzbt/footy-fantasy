import { describe, it, expect } from "vitest";
import {
  pickToRound,
  resolveDraftPosition,
  leagueSizeFromFormat,
} from "./snake";

describe("leagueSizeFromFormat", () => {
  it("maps eight → 8", () => expect(leagueSizeFromFormat("eight")).toBe(8));
  it("maps twelve → 12", () => expect(leagueSizeFromFormat("twelve")).toBe(12));
  it("maps sixteen → 16", () => expect(leagueSizeFromFormat("sixteen")).toBe(16));
});

describe("pickToRound", () => {
  it("pick 1 → round 1, pickInRound 1", () => {
    expect(pickToRound(1, 8)).toEqual({ round: 1, pickInRound: 1 });
  });

  it("pick N → round 1, pickInRound N", () => {
    expect(pickToRound(8, 8)).toEqual({ round: 1, pickInRound: 8 });
    expect(pickToRound(12, 12)).toEqual({ round: 1, pickInRound: 12 });
    expect(pickToRound(16, 16)).toEqual({ round: 1, pickInRound: 16 });
  });

  it("pick N+1 → round 2, pickInRound 1", () => {
    expect(pickToRound(9, 8)).toEqual({ round: 2, pickInRound: 1 });
    expect(pickToRound(13, 12)).toEqual({ round: 2, pickInRound: 1 });
    expect(pickToRound(17, 16)).toEqual({ round: 2, pickInRound: 1 });
  });

  it("pick 2N → round 2, pickInRound N", () => {
    expect(pickToRound(16, 8)).toEqual({ round: 2, pickInRound: 8 });
    expect(pickToRound(24, 12)).toEqual({ round: 2, pickInRound: 12 });
    expect(pickToRound(32, 16)).toEqual({ round: 2, pickInRound: 16 });
  });

  it("pick 2N+1 → round 3, pickInRound 1", () => {
    expect(pickToRound(17, 8)).toEqual({ round: 3, pickInRound: 1 });
    expect(pickToRound(25, 12)).toEqual({ round: 3, pickInRound: 1 });
    expect(pickToRound(33, 16)).toEqual({ round: 3, pickInRound: 1 });
  });

  it("last pick (14N) → round 14, pickInRound N", () => {
    expect(pickToRound(14 * 8, 8)).toEqual({ round: 14, pickInRound: 8 });
    expect(pickToRound(14 * 12, 12)).toEqual({ round: 14, pickInRound: 12 });
    expect(pickToRound(14 * 16, 16)).toEqual({ round: 14, pickInRound: 16 });
  });
});

describe("resolveDraftPosition", () => {
  it("pick 1 → position 1 (round 1, odd)", () => {
    expect(resolveDraftPosition(1, 8)).toBe(1);
  });

  it("pick N → position N (round 1, odd, last pick in round)", () => {
    expect(resolveDraftPosition(8, 8)).toBe(8);
    expect(resolveDraftPosition(12, 12)).toBe(12);
    expect(resolveDraftPosition(16, 16)).toBe(16);
  });

  it("pick N+1 → position N (round 2, even, snake flips)", () => {
    // Round 2, pickInRound 1 → position = N - 1 + 1 = N
    expect(resolveDraftPosition(9, 8)).toBe(8);
    expect(resolveDraftPosition(13, 12)).toBe(12);
    expect(resolveDraftPosition(17, 16)).toBe(16);
  });

  it("pick 2N → position 1 (round 2, even, last pick in round)", () => {
    // Round 2, pickInRound N → position = N - N + 1 = 1
    expect(resolveDraftPosition(16, 8)).toBe(1);
    expect(resolveDraftPosition(24, 12)).toBe(1);
    expect(resolveDraftPosition(32, 16)).toBe(1);
  });

  it("pick 2N+1 → position 1 (round 3, odd)", () => {
    expect(resolveDraftPosition(17, 8)).toBe(1);
    expect(resolveDraftPosition(25, 12)).toBe(1);
    expect(resolveDraftPosition(33, 16)).toBe(1);
  });

  it("last pick (14N): round 14 even, pickInRound N → position 1", () => {
    // Round 14 is even. pickInRound = N. position = N - N + 1 = 1.
    // Position 1 makes the last pick in every league size.
    expect(resolveDraftPosition(14 * 8, 8)).toBe(1);
    expect(resolveDraftPosition(14 * 12, 12)).toBe(1);
    expect(resolveDraftPosition(14 * 16, 16)).toBe(1);
  });
});

describe("input validation", () => {
  it("throws on pickNumber < 1", () => {
    expect(() => resolveDraftPosition(0, 8)).toThrow();
  });

  it("throws on pickNumber > 14 * leagueSize", () => {
    expect(() => resolveDraftPosition(14 * 8 + 1, 8)).toThrow();
  });

  it("throws on invalid leagueSize", () => {
    expect(() => resolveDraftPosition(1, 10)).toThrow();
    expect(() => pickToRound(1, 0)).toThrow();
  });
});
