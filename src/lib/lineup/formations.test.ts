import { describe, it, expect } from "vitest";
import { parseFormation, inferFormation, isValidFormation } from "./formations";

describe("isValidFormation", () => {
  it.each(["3-4-3", "3-5-2", "4-3-3", "4-4-2", "4-5-1", "5-3-2", "5-4-1"])(
    "returns true for %s",
    (f) => expect(isValidFormation(f)).toBe(true)
  );

  it.each(["4-2-4", "3-3-4", "1-9-1", "garbage", "4-4-3", "", "4-4-2-1"])(
    "returns false for %s",
    (f) => expect(isValidFormation(f)).toBe(false)
  );
});

describe("parseFormation", () => {
  it.each([
    ["3-4-3", { gk: 1, def: 3, mid: 4, fwd: 3 }],
    ["3-5-2", { gk: 1, def: 3, mid: 5, fwd: 2 }],
    ["4-3-3", { gk: 1, def: 4, mid: 3, fwd: 3 }],
    ["4-4-2", { gk: 1, def: 4, mid: 4, fwd: 2 }],
    ["4-5-1", { gk: 1, def: 4, mid: 5, fwd: 1 }],
    ["5-3-2", { gk: 1, def: 5, mid: 3, fwd: 2 }],
    ["5-4-1", { gk: 1, def: 5, mid: 4, fwd: 1 }],
  ] as const)("parseFormation('%s') → %j", (f, expected) => {
    expect(parseFormation(f)).toEqual(expected);
  });

  it.each(["4-2-4", "3-3-4", "1-9-1", "garbage"])(
    "throws for invalid '%s'",
    (f) => expect(() => parseFormation(f)).toThrow()
  );
});

describe("inferFormation", () => {
  type Pos = "GK" | "DEF" | "MID" | "FWD";
  it.each<[string, Pos[]]>([
    ["4-4-2", ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "FWD", "FWD"]],
    ["4-3-3", ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD"]],
    ["3-5-2", ["GK", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD"]],
    ["5-4-1", ["GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "FWD"]],
  ])("infers %s", (expected, positions) => {
    expect(inferFormation(positions)).toBe(expected);
  });

  it("returns null for 0 GK", () => {
    const pos = Array<"DEF">(11).fill("DEF");
    expect(inferFormation(pos)).toBeNull();
  });

  it("returns null for 2 GK", () => {
    const pos = ["GK", "GK", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD"] as const;
    expect(inferFormation([...pos])).toBeNull();
  });

  it("returns null for 12 players", () => {
    const pos = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD", "FWD"] as const;
    expect(inferFormation([...pos])).toBeNull();
  });

  it("returns null for 10 players", () => {
    const pos = ["GK", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD"] as const;
    expect(inferFormation([...pos])).toBeNull();
  });

  it("returns null for invalid distribution (4-2-4)", () => {
    const pos = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "FWD", "FWD", "FWD", "FWD"] as const;
    expect(inferFormation([...pos])).toBeNull();
  });
});
