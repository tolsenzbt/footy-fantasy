import { describe, it, expect } from "vitest";
import { mapRound } from "./round-map";

describe("mapRound — group stage", () => {
  it("maps 'Group Stage - 1' to group_md1", () => {
    expect(mapRound("Group Stage - 1")).toBe("group_md1");
  });

  it("maps 'Group Stage - 2' to group_md2", () => {
    expect(mapRound("Group Stage - 2")).toBe("group_md2");
  });

  it("maps 'Group Stage - 3' to group_md3", () => {
    expect(mapRound("Group Stage - 3")).toBe("group_md3");
  });

  it("maps lowercase variants", () => {
    expect(mapRound("group stage - 1")).toBe("group_md1");
    expect(mapRound("group stage - 2")).toBe("group_md2");
    expect(mapRound("group stage - 3")).toBe("group_md3");
  });

  it("maps full matchday label variants", () => {
    expect(mapRound("Group Stage - Matchday 1")).toBe("group_md1");
    expect(mapRound("Group Stage - Matchday 2")).toBe("group_md2");
    expect(mapRound("Group Stage - Matchday 3")).toBe("group_md3");
  });
});

describe("mapRound — knockout rounds", () => {
  it("maps 'Round of 32' to qf (real R32 → fantasy quarterfinals)", () => {
    expect(mapRound("Round of 32")).toBe("qf");
  });

  it("maps 'Round of 16' to sf (real R16 → fantasy semifinals)", () => {
    expect(mapRound("Round of 16")).toBe("sf");
  });

  it("maps 'Quarter-finals' to final (real QF → fantasy final)", () => {
    expect(mapRound("Quarter-finals")).toBe("final");
  });

  it("maps 'Quarterfinal' (no hyphen) to final", () => {
    expect(mapRound("Quarterfinal")).toBe("final");
  });

  // Regression: "Round of 16" must NOT map to "qf". The old code had a
  // "round of 16 - 2" → "qf" branch which was wrong; it has been removed.
  it("regression — 'Round of 16' does NOT map to qf", () => {
    expect(mapRound("Round of 16")).not.toBe("qf");
  });

  it("returns null for an unknown string", () => {
    expect(mapRound("Semi-finals")).toBeNull();
    expect(mapRound("")).toBeNull();
    expect(mapRound("3rd Place Final")).toBeNull();
  });
});
