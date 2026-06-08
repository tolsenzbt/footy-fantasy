import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeNextPicker,
  isRedraftExhausted,
  isInFrozenPool,
  sortByNeed,
  selectAutoPick,
  type DraftOrderEntry,
  type ByNeedEntry,
} from "./redraft";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEntries(
  count: number,
  opts: Partial<Record<number, { optedOut?: boolean }>> = {}
): DraftOrderEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const pos = i + 1;
    return {
      id: `id-${pos}`,
      managerId: `m${pos}`,
      position: pos,
      optedOut: opts[pos]?.optedOut ?? false,
    };
  });
}

// ── computeNextPicker ──────────────────────────────────────────────────────────

describe("computeNextPicker — no opt-outs", () => {
  it("returns null for empty entries", () => {
    expect(computeNextPicker(1, [])).toBeNull();
  });

  it("pick 1 → first position (m1)", () => {
    const entries = makeEntries(4);
    expect(computeNextPicker(1, entries)).toBe("m1");
  });

  it("round 1 snake: positions 1,2,3,4", () => {
    const entries = makeEntries(4);
    expect(computeNextPicker(1, entries)).toBe("m1");
    expect(computeNextPicker(2, entries)).toBe("m2");
    expect(computeNextPicker(3, entries)).toBe("m3");
    expect(computeNextPicker(4, entries)).toBe("m4");
  });

  it("round 2 snake (even round flips): positions 4,3,2,1", () => {
    const entries = makeEntries(4);
    expect(computeNextPicker(5, entries)).toBe("m4");
    expect(computeNextPicker(6, entries)).toBe("m3");
    expect(computeNextPicker(7, entries)).toBe("m2");
    expect(computeNextPicker(8, entries)).toBe("m1");
  });

  it("round 3 repeats round 1 order", () => {
    const entries = makeEntries(4);
    expect(computeNextPicker(9, entries)).toBe("m1");
    expect(computeNextPicker(10, entries)).toBe("m2");
  });

  it("returns null past 10-round cap (pick 81 for N=8)", () => {
    const entries = makeEntries(8);
    // pick 80 = last valid
    expect(computeNextPicker(80, entries)).not.toBeNull();
    // pick 81 is beyond 10 * 8 = 80
    expect(computeNextPicker(81, entries)).toBeNull();
  });
});

describe("computeNextPicker — with opt-outs", () => {
  it("skips opted-out manager, returns next active", () => {
    // N=4, position 2 opted out
    // Round 1 global snake: 1,2,3,4 → active sees 1,(skip),3,4
    const entries = makeEntries(4, { 2: { optedOut: true } });
    expect(computeNextPicker(1, entries)).toBe("m1");
    expect(computeNextPicker(2, entries)).toBe("m3"); // m2 skipped
    expect(computeNextPicker(3, entries)).toBe("m4");
  });

  it("round 2 with opt-out: snake reversal skips opted-out slot", () => {
    // N=4, m2 opted out. Round 2 global: 4,3,2,1 → active sees 4,3,(skip m2),1
    const entries = makeEntries(4, { 2: { optedOut: true } });
    expect(computeNextPicker(4, entries)).toBe("m4"); // round 2 pick 1
    expect(computeNextPicker(5, entries)).toBe("m3");
    expect(computeNextPicker(6, entries)).toBe("m1"); // m2 slot skipped
  });

  it("all opted out returns null", () => {
    const entries = makeEntries(3, { 1: { optedOut: true }, 2: { optedOut: true }, 3: { optedOut: true } });
    expect(computeNextPicker(1, entries)).toBeNull();
  });

  it("one participant remaining still works", () => {
    const entries = makeEntries(4, { 1: { optedOut: true }, 3: { optedOut: true }, 4: { optedOut: true } });
    // Only m2 active; picks always go to m2
    expect(computeNextPicker(1, entries)).toBe("m2");
    expect(computeNextPicker(2, entries)).toBe("m2");
    expect(computeNextPicker(10, entries)).toBe("m2"); // round ceil(10/4)=3, position 2
  });
});

describe("isRedraftExhausted", () => {
  it("not exhausted at pick 1 with active managers", () => {
    expect(isRedraftExhausted(1, makeEntries(8))).toBe(false);
  });

  it("exhausted past 10-round cap", () => {
    expect(isRedraftExhausted(81, makeEntries(8))).toBe(true);
  });

  it("exhausted when all opted out", () => {
    const entries = makeEntries(2, { 1: { optedOut: true }, 2: { optedOut: true } });
    expect(isRedraftExhausted(1, entries)).toBe(true);
  });
});

// ── isInFrozenPool ─────────────────────────────────────────────────────────────

describe("isInFrozenPool — frozen-pool filter", () => {
  it("rostered player is not in pool", () => {
    expect(isInFrozenPool("rostered", null)).toBe(false);
    expect(isInFrozenPool("rostered", "mass_release")).toBe(false);
  });

  it("free_agent is in pool regardless of dropReason", () => {
    expect(isInFrozenPool("free_agent", null)).toBe(true);
    expect(isInFrozenPool("free_agent", "manager_drop")).toBe(true);
  });

  it("on_waivers with mass_release reason is in pool", () => {
    expect(isInFrozenPool("on_waivers", "mass_release")).toBe(true);
  });

  it("on_waivers with null reason is in pool (undrafted legacy)", () => {
    expect(isInFrozenPool("on_waivers", null)).toBe(true);
  });

  it("on_waivers with manager_drop is NOT in pool (mid-draft drop excluded)", () => {
    expect(isInFrozenPool("on_waivers", "manager_drop")).toBe(false);
  });
});

// ── sortByNeed — by-need ordering ─────────────────────────────────────────────

describe("sortByNeed — by-need ordering with both tiebreakers", () => {
  const makeEntry = (
    id: string,
    drops: number,
    pts: number,
    highest: number
  ): ByNeedEntry => ({
    managerId: id,
    autoDroppedCount: drops,
    groupStagePoints: pts,
    highestSingleScore: highest,
  });

  it("primary sort: more auto-drops ranks higher", () => {
    const input = [
      makeEntry("A", 1, 200, 80),
      makeEntry("B", 3, 50, 30),
      makeEntry("C", 2, 100, 60),
    ];
    const sorted = sortByNeed(input);
    expect(sorted.map((e) => e.managerId)).toEqual(["B", "C", "A"]);
  });

  it("tiebreaker 1: equal drops → more group-stage points ranks higher", () => {
    const input = [
      makeEntry("X", 3, 140, 60),
      makeEntry("Y", 3, 150, 55),
    ];
    const sorted = sortByNeed(input);
    expect(sorted[0].managerId).toBe("Y");
    expect(sorted[1].managerId).toBe("X");
  });

  it("tiebreaker 2: equal drops AND equal group-stage points → higher single score wins", () => {
    const input = [
      makeEntry("E", 2, 100, 60),
      makeEntry("F", 2, 100, 70),
    ];
    const sorted = sortByNeed(input);
    expect(sorted[0].managerId).toBe("F");
    expect(sorted[1].managerId).toBe("E");
  });

  it("full 4-manager scenario exercising all tiebreakers", () => {
    const input = [
      makeEntry("A", 3, 150, 60), // wins primary
      makeEntry("B", 3, 140, 70), // tied primary, loses tb1
      makeEntry("C", 2, 200, 80), // loses primary
      makeEntry("D", 1, 50, 30),  // last
    ];
    const sorted = sortByNeed(input);
    expect(sorted.map((e) => e.managerId)).toEqual(["A", "B", "C", "D"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeEntry("Z", 1, 100, 50), makeEntry("W", 2, 90, 40)];
    const original = [...input];
    sortByNeed(input);
    expect(input).toEqual(original);
  });
});

// ── selectAutoPick ─────────────────────────────────────────────────────────────

describe("selectAutoPick — timeout auto-pick selection", () => {
  type PoolPlayer = {
    playerId: string;
    position: "GK" | "DEF" | "MID" | "FWD";
    groupStagePoints: number;
  };

  it("returns null for empty pool", () => {
    expect(selectAutoPick([], [])).toBeNull();
  });

  it("returns null when all pool players exceed position max", () => {
    // Roster already has 2 GKs (max), pool only has GKs
    const pool: PoolPlayer[] = [
      { playerId: "gk1", position: "GK", groupStagePoints: 50 },
    ];
    const roster: Array<"GK" | "DEF" | "MID" | "FWD"> = ["GK", "GK"];
    expect(selectAutoPick(pool, roster)).toBeNull();
  });

  it("picks highest group-stage points from eligible players", () => {
    const pool: PoolPlayer[] = [
      { playerId: "p1", position: "MID", groupStagePoints: 40 },
      { playerId: "p2", position: "MID", groupStagePoints: 80 },
      { playerId: "p3", position: "MID", groupStagePoints: 60 },
    ];
    expect(selectAutoPick(pool, [])).toBe("p2");
  });

  it("filters out positions at their maximum before selecting best", () => {
    // DEF is at max (5), only MID/FWD available
    const pool: PoolPlayer[] = [
      { playerId: "def1", position: "DEF", groupStagePoints: 200 },
      { playerId: "mid1", position: "MID", groupStagePoints: 50 },
    ];
    const roster: Array<"GK" | "DEF" | "MID" | "FWD"> = [
      "DEF", "DEF", "DEF", "DEF", "DEF",
    ];
    expect(selectAutoPick(pool, roster)).toBe("mid1"); // DEF at max, so mid1 wins
  });

  it("skip scenario: roster full (14 players) — caller must detect and not invoke selectAutoPick", () => {
    // The auto-pick call itself doesn't know about roster size cap;
    // resolveExpiredRedraftPick checks rosterSize >= 14 before calling.
    // This test documents the skip path by showing an empty pool also returns null.
    expect(selectAutoPick([], ["GK"])).toBeNull();
  });
});

// ── §10 ownership invariant — redraft and mass-release scenarios ───────────────
//
// These tests simulate ownership state transitions (no DB) to confirm the
// two-table invariant (I1–I4) holds across redraft picks and mass-release drops.
//
// State model mirrors ownership-invariant.test.ts.

type PlayerStatus = "rostered" | "on_waivers" | "free_agent";
type DropReason = "mass_release" | "manager_drop" | null;

type OwnershipState = {
  rosters: Map<string, Set<string>>;
  playerStatus: Map<string, PlayerStatus>;
  playerDropReason: Map<string, DropReason>;
};

function checkInvariant(state: OwnershipState): string[] {
  const violations: string[] = [];
  const rosterMemberships = new Map<string, Set<string>>();
  for (const [mgr, players] of state.rosters) {
    for (const p of players) {
      const s = rosterMemberships.get(p) ?? new Set<string>();
      s.add(mgr);
      rosterMemberships.set(p, s);
    }
  }
  for (const [playerId, status] of state.playerStatus) {
    if (status === "rostered") {
      const managers = rosterMemberships.get(playerId);
      if (!managers || managers.size === 0) {
        violations.push(`I1: player ${playerId} status='rostered' but no roster row`);
      } else if (managers.size > 1) {
        violations.push(`I1: player ${playerId} on multiple rosters`);
      }
    }
  }
  for (const [playerId, managers] of rosterMemberships) {
    if (managers.size > 0) {
      const status = state.playerStatus.get(playerId);
      if (status !== "rostered") {
        violations.push(`I2: player ${playerId} has roster row but status='${status}'`);
      }
    }
  }
  for (const [playerId, status] of state.playerStatus) {
    if (status === "on_waivers" || status === "free_agent") {
      const managers = rosterMemberships.get(playerId);
      if (managers && managers.size > 0) {
        violations.push(`I3/I4: player ${playerId} status='${status}' but has roster row`);
      }
    }
  }
  return violations;
}

// Simulate a redraft pick: add player to manager's roster, optionally drop another
function applyRedraftPick(
  state: OwnershipState,
  managerId: string,
  playerId: string,
  dropPlayerId: string | null
): OwnershipState {
  const rosters = new Map<string, Set<string>>();
  for (const [mgr, ps] of state.rosters) rosters.set(mgr, new Set(ps));
  const playerStatus = new Map(state.playerStatus);
  const playerDropReason = new Map(state.playerDropReason);

  if (!rosters.has(managerId)) rosters.set(managerId, new Set());
  rosters.get(managerId)!.add(playerId);
  playerStatus.set(playerId, "rostered");
  playerDropReason.set(playerId, null);

  if (dropPlayerId) {
    rosters.get(managerId)?.delete(dropPlayerId);
    playerStatus.set(dropPlayerId, "on_waivers");
    playerDropReason.set(dropPlayerId, "manager_drop");
  }

  return { rosters, playerStatus, playerDropReason };
}

// Simulate mass-release: drop all players from eliminated nations on advancing managers
function applyMassRelease(
  state: OwnershipState,
  advancingManagerIds: string[],
  eliminatedPlayerIds: string[]
): OwnershipState {
  const rosters = new Map<string, Set<string>>();
  for (const [mgr, ps] of state.rosters) rosters.set(mgr, new Set(ps));
  const playerStatus = new Map(state.playerStatus);
  const playerDropReason = new Map(state.playerDropReason);

  const advancingSet = new Set(advancingManagerIds);

  for (const [mgr, ps] of rosters) {
    if (!advancingSet.has(mgr)) continue; // eliminated manager — skip
    for (const playerId of eliminatedPlayerIds) {
      if (ps.has(playerId)) {
        ps.delete(playerId);
        playerStatus.set(playerId, "on_waivers");
        playerDropReason.set(playerId, "mass_release");
      }
    }
  }

  return { rosters, playerStatus, playerDropReason };
}

describe("§10 invariant — redraft pick transitions", () => {
  const makeState = (): OwnershipState => ({
    rosters: new Map([["m1", new Set(["r1", "r2"])]]),
    playerStatus: new Map<string, PlayerStatus>([
      ["r1", "rostered"],
      ["r2", "rostered"],
      ["pA", "on_waivers"],
      ["pB", "free_agent"],
    ]),
    playerDropReason: new Map<string, DropReason>([
      ["pA", "mass_release"],
      ["pB", null],
    ]),
  });

  it("pick with open spot: player rostered, no drop — invariant holds", () => {
    const state = applyRedraftPick(makeState(), "m1", "pA", null);
    expect(checkInvariant(state)).toHaveLength(0);
    expect(state.playerStatus.get("pA")).toBe("rostered");
    expect(state.rosters.get("m1")?.has("pA")).toBe(true);
  });

  it("pick with drop: player rostered, dropped goes on_waivers — invariant holds", () => {
    const state = applyRedraftPick(makeState(), "m1", "pA", "r1");
    expect(checkInvariant(state)).toHaveLength(0);
    expect(state.playerStatus.get("pA")).toBe("rostered");
    expect(state.playerStatus.get("r1")).toBe("on_waivers");
    expect(state.playerDropReason.get("r1")).toBe("manager_drop");
    expect(state.rosters.get("m1")?.has("r1")).toBe(false);
  });

  it("mid-redraft drop is NOT in frozen pool (manager_drop reason)", () => {
    const state = applyRedraftPick(makeState(), "m1", "pA", "r1");
    expect(isInFrozenPool("on_waivers", state.playerDropReason.get("r1") ?? null)).toBe(false);
  });

  it("multiple sequential picks maintain invariant", () => {
    let state = makeState();
    state = applyRedraftPick(state, "m1", "pA", null);
    state = applyRedraftPick(state, "m1", "pB", "r2");
    expect(checkInvariant(state)).toHaveLength(0);
  });
});

describe("§10 invariant — mass-release transitions", () => {
  const makeState = (): OwnershipState => ({
    rosters: new Map([
      ["m1", new Set(["eliminated1", "eliminated2", "alive1"])], // advancing
      ["m2", new Set(["eliminated3"])], // advancing
      ["m3", new Set(["eliminated4", "alive2"])], // eliminated manager
    ]),
    playerStatus: new Map<string, PlayerStatus>([
      ["eliminated1", "rostered"],
      ["eliminated2", "rostered"],
      ["alive1", "rostered"],
      ["eliminated3", "rostered"],
      ["eliminated4", "rostered"],
      ["alive2", "rostered"],
    ]),
    playerDropReason: new Map<string, DropReason>(),
  });

  it("advancing managers lose eliminated-nation players; eliminated managers untouched", () => {
    const state = applyMassRelease(
      makeState(),
      ["m1", "m2"],          // advancing
      ["eliminated1", "eliminated2", "eliminated3", "eliminated4"]
    );
    expect(checkInvariant(state)).toHaveLength(0);

    // m1 (advancing): eliminated1,2 dropped; alive1 kept
    expect(state.playerStatus.get("eliminated1")).toBe("on_waivers");
    expect(state.playerDropReason.get("eliminated1")).toBe("mass_release");
    expect(state.playerStatus.get("eliminated2")).toBe("on_waivers");
    expect(state.playerStatus.get("alive1")).toBe("rostered");
    expect(state.rosters.get("m1")).toEqual(new Set(["alive1"]));

    // m2 (advancing): eliminated3 dropped
    expect(state.playerStatus.get("eliminated3")).toBe("on_waivers");
    expect(state.rosters.get("m2")?.size).toBe(0);

    // m3 (eliminated manager): untouched — eliminated4 and alive2 still rostered
    expect(state.playerStatus.get("eliminated4")).toBe("rostered");
    expect(state.playerStatus.get("alive2")).toBe("rostered");
    expect(state.rosters.get("m3")).toEqual(new Set(["eliminated4", "alive2"]));
  });

  it("mass-released players are in frozen pool", () => {
    const state = applyMassRelease(makeState(), ["m1"], ["eliminated1"]);
    const reason = state.playerDropReason.get("eliminated1") ?? null;
    expect(isInFrozenPool("on_waivers", reason)).toBe(true);
  });

  it("no drops when no advancing managers", () => {
    const state = applyMassRelease(makeState(), [], ["eliminated1", "eliminated2"]);
    expect(checkInvariant(state)).toHaveLength(0);
    // Nothing changed
    expect(state.playerStatus.get("eliminated1")).toBe("rostered");
  });
});
