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

describe("pickToRound (initial draft — 14 rounds)", () => {
  it("pick 1 → round 1, pickInRound 1", () => {
    expect(pickToRound(1, 8, 14)).toEqual({ round: 1, pickInRound: 1 });
  });

  it("pick N → round 1, pickInRound N", () => {
    expect(pickToRound(8, 8, 14)).toEqual({ round: 1, pickInRound: 8 });
    expect(pickToRound(12, 12, 14)).toEqual({ round: 1, pickInRound: 12 });
    expect(pickToRound(16, 16, 14)).toEqual({ round: 1, pickInRound: 16 });
  });

  it("pick N+1 → round 2, pickInRound 1", () => {
    expect(pickToRound(9, 8, 14)).toEqual({ round: 2, pickInRound: 1 });
    expect(pickToRound(13, 12, 14)).toEqual({ round: 2, pickInRound: 1 });
    expect(pickToRound(17, 16, 14)).toEqual({ round: 2, pickInRound: 1 });
  });

  it("pick 2N → round 2, pickInRound N", () => {
    expect(pickToRound(16, 8, 14)).toEqual({ round: 2, pickInRound: 8 });
    expect(pickToRound(24, 12, 14)).toEqual({ round: 2, pickInRound: 12 });
    expect(pickToRound(32, 16, 14)).toEqual({ round: 2, pickInRound: 16 });
  });

  it("pick 2N+1 → round 3, pickInRound 1", () => {
    expect(pickToRound(17, 8, 14)).toEqual({ round: 3, pickInRound: 1 });
    expect(pickToRound(25, 12, 14)).toEqual({ round: 3, pickInRound: 1 });
    expect(pickToRound(33, 16, 14)).toEqual({ round: 3, pickInRound: 1 });
  });

  it("last pick (14N) → round 14, pickInRound N", () => {
    expect(pickToRound(14 * 8, 8, 14)).toEqual({ round: 14, pickInRound: 8 });
    expect(pickToRound(14 * 12, 12, 14)).toEqual({ round: 14, pickInRound: 12 });
    expect(pickToRound(14 * 16, 16, 14)).toEqual({ round: 14, pickInRound: 16 });
  });
});

describe("resolveDraftPosition (initial draft — 14 rounds)", () => {
  it("pick 1 → position 1 (round 1, odd)", () => {
    expect(resolveDraftPosition(1, 8, 14)).toBe(1);
  });

  it("pick N → position N (round 1, odd, last pick in round)", () => {
    expect(resolveDraftPosition(8, 8, 14)).toBe(8);
    expect(resolveDraftPosition(12, 12, 14)).toBe(12);
    expect(resolveDraftPosition(16, 16, 14)).toBe(16);
  });

  it("pick N+1 → position N (round 2, even, snake flips)", () => {
    expect(resolveDraftPosition(9, 8, 14)).toBe(8);
    expect(resolveDraftPosition(13, 12, 14)).toBe(12);
    expect(resolveDraftPosition(17, 16, 14)).toBe(16);
  });

  it("pick 2N → position 1 (round 2, even, last pick in round)", () => {
    expect(resolveDraftPosition(16, 8, 14)).toBe(1);
    expect(resolveDraftPosition(24, 12, 14)).toBe(1);
    expect(resolveDraftPosition(32, 16, 14)).toBe(1);
  });

  it("pick 2N+1 → position 1 (round 3, odd)", () => {
    expect(resolveDraftPosition(17, 8, 14)).toBe(1);
    expect(resolveDraftPosition(25, 12, 14)).toBe(1);
    expect(resolveDraftPosition(33, 16, 14)).toBe(1);
  });

  it("last pick (14N): round 14 even, pickInRound N → position 1", () => {
    expect(resolveDraftPosition(14 * 8, 8, 14)).toBe(1);
    expect(resolveDraftPosition(14 * 12, 12, 14)).toBe(1);
    expect(resolveDraftPosition(14 * 16, 16, 14)).toBe(1);
  });
});

describe("resolveDraftPosition (redraft — 10 rounds, N=8)", () => {
  it("pick 1 → position 1 (round 1, odd)", () => {
    expect(resolveDraftPosition(1, 8, 10)).toBe(1);
  });

  it("pick 8 → position 8 (round 1, odd, end of round)", () => {
    expect(resolveDraftPosition(8, 8, 10)).toBe(8);
  });

  it("pick 9 → position 8 (round 2, even, snake flips)", () => {
    expect(resolveDraftPosition(9, 8, 10)).toBe(8);
  });

  it("pick 16 → position 1 (round 2, even, last in round)", () => {
    expect(resolveDraftPosition(16, 8, 10)).toBe(1);
  });

  it("last pick (80) → round 10 even, position 1", () => {
    expect(resolveDraftPosition(80, 8, 10)).toBe(1);
  });
});

describe("input validation", () => {
  it("throws on pickNumber < 1", () => {
    expect(() => resolveDraftPosition(0, 8, 14)).toThrow();
  });

  it("throws on pickNumber > totalRounds * participantCount", () => {
    expect(() => resolveDraftPosition(14 * 8 + 1, 8, 14)).toThrow();
    expect(() => resolveDraftPosition(10 * 8 + 1, 8, 10)).toThrow();
  });

  it("throws on participantCount < 1", () => {
    expect(() => resolveDraftPosition(1, 0, 14)).toThrow();
    expect(() => pickToRound(1, 0, 14)).toThrow();
  });

  it("throws on totalRounds < 1", () => {
    expect(() => resolveDraftPosition(1, 8, 0)).toThrow();
  });
});
