/**
 * Ownership invariant tests for the waiver system.
 *
 * The system stores player ownership in TWO places that must never disagree:
 *   - rosters table: a row exists ⟺ player is rostered by that manager
 *   - waiver_player_status.status: 'rostered' | 'on_waivers' | 'free_agent'
 *
 * All write paths (actions.ts, cron route) update both inside a transaction.
 * These tests verify that for any resolver output, a faithful applier produces
 * a state that satisfies all four invariant clauses:
 *
 *   I1: player with status='rostered' → has exactly one roster row
 *   I2: player in a roster → status='rostered'
 *   I3: player with status='on_waivers' → no roster row
 *   I4: player with status='free_agent' → no roster row
 *
 * NOTE ON A SEPARATE BUG (does NOT violate these four clauses):
 *   resolver.ts:104 uses `effectiveRosters.get(managerId) ?? new Set<string>()`.
 *   If a manager appears in priorityOrder but has NO entry in snapshot.rosters
 *   (e.g. empty-roster manager not added by the cron handler), mutations to the
 *   temporary Set are discarded. The manager's effective size is always 0, so they
 *   can receive more awards than maxRosterSize allows. This violates the roster-size
 *   constraint but NOT the two-table ownership invariant. The award transactions
 *   emitted are still structurally correct (player ↔ status correspondence is fine).
 *   The cron handler should always include all managers in snapshot.rosters, even
 *   for empty rosters, to avoid this issue.
 */

import { describe, it, expect } from "vitest";
import {
  processWaivers,
  type WaiverSnapshot,
  type WaiverTransaction,
} from "./resolver";

// ── Ownership state model ─────────────────────────────────────────────────────

type PlayerStatus = "rostered" | "on_waivers" | "free_agent";

type OwnershipState = {
  /** managerId -> Set<playerId> */
  rosters: Map<string, Set<string>>;
  /** playerId -> status */
  playerStatus: Map<string, PlayerStatus>;
};

// ── Invariant checker ─────────────────────────────────────────────────────────

function checkInvariant(state: OwnershipState): string[] {
  const violations: string[] = [];

  // Build playerId -> Set<managerId> index
  const rosterMemberships = new Map<string, Set<string>>();
  for (const [mgr, players] of state.rosters) {
    for (const p of players) {
      const s = rosterMemberships.get(p) ?? new Set<string>();
      s.add(mgr);
      rosterMemberships.set(p, s);
    }
  }

  // I1: status='rostered' → exactly one roster row
  for (const [playerId, status] of state.playerStatus) {
    if (status === "rostered") {
      const managers = rosterMemberships.get(playerId);
      if (!managers || managers.size === 0) {
        violations.push(
          `I1: player ${playerId} status='rostered' but no roster row`
        );
      } else if (managers.size > 1) {
        violations.push(
          `I1: player ${playerId} status='rostered' but on ${managers.size} rosters`
        );
      }
    }
  }

  // I2: roster row → status='rostered'
  for (const [playerId, managers] of rosterMemberships) {
    if (managers.size > 0) {
      const status = state.playerStatus.get(playerId);
      if (status !== "rostered") {
        violations.push(
          `I2: player ${playerId} has roster row(s) but status='${status ?? "(missing)"}'`
        );
      }
    }
  }

  // I3 + I4: status='on_waivers' or 'free_agent' → no roster row
  for (const [playerId, status] of state.playerStatus) {
    if (status === "on_waivers" || status === "free_agent") {
      const managers = rosterMemberships.get(playerId);
      if (managers && managers.size > 0) {
        violations.push(
          `I3/I4: player ${playerId} status='${status}' but has roster row`
        );
      }
    }
  }

  return violations;
}

// ── Simulated applier ─────────────────────────────────────────────────────────
//
// Models exactly what the cron route does inside its transaction for award txs:
//   - add playerId to rosters[managerId], set playerStatus='rostered'
//   - if dropPlayerId: remove from rosters[managerId], set playerStatus='on_waivers'
// Fail / invalid / void transactions carry no ownership change.

function applyAwards(
  initial: OwnershipState,
  transactions: WaiverTransaction[]
): OwnershipState {
  const rosters = new Map<string, Set<string>>();
  for (const [mgr, players] of initial.rosters) {
    rosters.set(mgr, new Set(players));
  }
  const playerStatus = new Map(initial.playerStatus);

  for (const tx of transactions) {
    if (tx.type !== "award") continue;

    // Acquire
    if (!rosters.has(tx.managerId)) rosters.set(tx.managerId, new Set());
    rosters.get(tx.managerId)!.add(tx.playerId);
    playerStatus.set(tx.playerId, "rostered");

    // Conditional drop
    if (tx.dropPlayerId !== null) {
      rosters.get(tx.managerId)?.delete(tx.dropPlayerId);
      playerStatus.set(tx.dropPlayerId, "on_waivers");
    }
  }

  return { rosters, playerStatus };
}

// ── Initial state builder ─────────────────────────────────────────────────────
//
// Derives a consistent OwnershipState from a WaiverSnapshot:
//   - rosters are copied directly
//   - players in any roster → 'rostered'
//   - players in availablePlayers → 'on_waivers'
//   - all other named players → 'free_agent'

function initialStateFromSnapshot(
  snapshot: WaiverSnapshot,
  extraFreeAgents: string[] = []
): OwnershipState {
  const rosters = new Map<string, Set<string>>();
  for (const [mgr, players] of snapshot.rosters) {
    rosters.set(mgr, new Set(players));
  }

  const playerStatus = new Map<string, PlayerStatus>();

  for (const [, players] of snapshot.rosters) {
    for (const p of players) playerStatus.set(p, "rostered");
  }
  for (const p of snapshot.availablePlayers) {
    playerStatus.set(p, "on_waivers");
  }
  for (const p of extraFreeAgents) {
    if (!playerStatus.has(p)) playerStatus.set(p, "free_agent");
  }

  return { rosters, playerStatus };
}

// ── Snapshot builder ──────────────────────────────────────────────────────────

function makeSnapshot(opts: {
  priority: Array<[string, number]>;
  claims: Array<{
    id: string;
    managerId: string;
    playerId: string;
    dropPlayerId?: string;
    rank: number;
  }>;
  rosters: Record<string, string[]>;
  available: string[];
  maxRosterSize?: number;
}): WaiverSnapshot {
  return {
    priorityOrder: opts.priority.map(([managerId, priority]) => ({
      managerId,
      priority,
    })),
    claims: opts.claims.map((c) => ({
      ...c,
      dropPlayerId: c.dropPlayerId ?? null,
    })),
    rosters: new Map(
      Object.entries(opts.rosters).map(([mgr, players]) => [
        mgr,
        new Set(players),
      ])
    ),
    availablePlayers: new Set(opts.available),
    maxRosterSize: opts.maxRosterSize ?? 14,
  };
}

// Helper: run resolver and return final ownership state
function resolveAndApply(
  snap: WaiverSnapshot,
  extraFreeAgents: string[] = []
): OwnershipState {
  const { transactions } = processWaivers(snap);
  const initial = initialStateFromSnapshot(snap, extraFreeAgents);
  return applyAwards(initial, transactions);
}

// ── Invariant checker self-tests ──────────────────────────────────────────────
// These verify the checker itself catches every violation type.

describe("invariant checker self-tests", () => {
  it("I1: detects status='rostered' with no roster row", () => {
    const state: OwnershipState = {
      rosters: new Map([["m1", new Set<string>()]]),
      playerStatus: new Map([["pA", "rostered" as PlayerStatus]]),
    };
    const v = checkInvariant(state);
    expect(v.some((s) => s.includes("I1") && s.includes("pA"))).toBe(true);
  });

  it("I1: detects player on two rosters simultaneously", () => {
    const state: OwnershipState = {
      rosters: new Map([
        ["m1", new Set(["pA"])],
        ["m2", new Set(["pA"])],
      ]),
      playerStatus: new Map([["pA", "rostered" as PlayerStatus]]),
    };
    const v = checkInvariant(state);
    expect(v.some((s) => s.includes("I1") && s.includes("pA"))).toBe(true);
  });

  it("I2: detects roster row with status not 'rostered'", () => {
    const state: OwnershipState = {
      rosters: new Map([["m1", new Set(["pA"])]]),
      playerStatus: new Map([["pA", "on_waivers" as PlayerStatus]]),
    };
    const v = checkInvariant(state);
    expect(v.some((s) => s.includes("I2") && s.includes("pA"))).toBe(true);
  });

  it("I3: detects status='on_waivers' with a roster row", () => {
    const state: OwnershipState = {
      rosters: new Map([["m1", new Set(["pA"])]]),
      playerStatus: new Map([["pA", "on_waivers" as PlayerStatus]]),
    };
    const v = checkInvariant(state);
    expect(v.some((s) => s.includes("I3/I4") && s.includes("pA"))).toBe(true);
  });

  it("I4: detects status='free_agent' with a roster row", () => {
    const state: OwnershipState = {
      rosters: new Map([["m1", new Set(["pA"])]]),
      playerStatus: new Map([["pA", "free_agent" as PlayerStatus]]),
    };
    const v = checkInvariant(state);
    expect(v.some((s) => s.includes("I3/I4") && s.includes("pA"))).toBe(true);
  });

  it("consistent state produces no violations", () => {
    const state: OwnershipState = {
      rosters: new Map([["m1", new Set(["pA"])]]),
      playerStatus: new Map<string, PlayerStatus>([
        ["pA", "rostered"],
        ["pB", "on_waivers"],
        ["pC", "free_agent"],
      ]),
    };
    expect(checkInvariant(state)).toHaveLength(0);
  });
});

// ── Scenario: award without conditional drop ──────────────────────────────────

describe("award without conditional drop", () => {
  it("awarded player moves from on_waivers to rostered — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: [] },
      available: ["pA"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
  });

  it("awarded player leaves no on_waivers row", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: [] },
      available: ["pA"],
    });
    const final = resolveAndApply(snap);
    expect(final.playerStatus.get("pA")).toBe("rostered");
  });

  it("non-claimed waiver player retains on_waivers status — no violations", () => {
    // pA claimed, pB not claimed
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: [] },
      available: ["pA", "pB"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pB")).toBe("on_waivers");
  });

  it("free agent player not involved in waivers remains free_agent — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: [] },
      available: ["pA"],
    });
    const final = resolveAndApply(snap, ["pFree"]);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pFree")).toBe("free_agent");
  });
});

// ── Scenario: award with conditional drop ────────────────────────────────────

describe("award with conditional drop", () => {
  it("awarded player rostered, dropped player on_waivers — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r1",
          rank: 1,
        },
      ],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pA")).toBe("rostered");
    expect(final.playerStatus.get("r1")).toBe("on_waivers");
  });

  it("dropped player has no roster row after drop", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r1",
          rank: 1,
        },
      ],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const final = resolveAndApply(snap);
    const m1Roster = final.rosters.get("m1")!;
    expect(m1Roster.has("r1")).toBe(false);
    expect(m1Roster.has("pA")).toBe(true);
  });

  it("drop not executed when drop player absent from roster (space exists) — no violations", () => {
    // Claim specifies drop r99 but r99 is not on roster; roster has space → award without drop
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r99",
          rank: 1,
        },
      ],
      rosters: { m1: [] }, // space available, r99 not present
      available: ["pA"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    // r99 is not in playerStatus at all — it was never part of this snapshot
    expect(final.playerStatus.get("r99")).toBeUndefined();
  });
});

// ── Scenario: failed / invalid / void claims ──────────────────────────────────

describe("non-award transactions produce no ownership change", () => {
  it("failed claim (player taken by higher-priority): loser ownership unchanged — no violations", () => {
    const snap = makeSnapshot({
      priority: [
        ["m1", 1],
        ["m2", 2],
      ],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    // m2 roster still empty — no spurious roster row
    expect(final.rosters.get("m2")?.size ?? 0).toBe(0);
  });

  it("invalid claim (roster full, no drop): player stays on_waivers — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pA")).toBe("on_waivers");
    expect(final.playerStatus.get("r1")).toBe("rostered");
  });

  it("voided claim (shared drop already used): voided-target player stays on_waivers — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r1",
          rank: 1,
        },
        {
          id: "c2",
          managerId: "m1",
          playerId: "pB",
          dropPlayerId: "r1",
          rank: 2,
        },
      ],
      rosters: { m1: ["r1"] },
      available: ["pA", "pB"],
      maxRosterSize: 1,
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    // pA awarded, r1 dropped; pB voided → pB still on_waivers
    expect(final.playerStatus.get("pB")).toBe("on_waivers");
    expect(final.rosters.get("m1")?.has("pB")).toBe(false);
  });
});

// ── Scenario: multi-manager competition ───────────────────────────────────────

describe("multi-manager scenarios", () => {
  it("priority winner adds player, loser unchanged — no violations", () => {
    const snap = makeSnapshot({
      priority: [
        ["m1", 1],
        ["m2", 2],
      ],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
      ],
      rosters: { m1: [], m2: ["r2"] },
      available: ["pA"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    // m1 wins pA; m2 keeps r2 and doesn't acquire pA
    expect(final.playerStatus.get("pA")).toBe("rostered");
    expect(final.rosters.get("m2")?.has("pA")).toBe(false);
    expect(final.rosters.get("m2")?.has("r2")).toBe(true);
  });

  it("each manager awarded a different player — no violations", () => {
    const snap = makeSnapshot({
      priority: [
        ["m1", 1],
        ["m2", 2],
      ],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pB", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA", "pB"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
  });

  it("fixpoint: m1 takes pA, m2 falls back to pB — both rostered, no cross-ownership", () => {
    const snap = makeSnapshot({
      priority: [
        ["m1", 1],
        ["m2", 2],
      ],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
        { id: "c3", managerId: "m2", playerId: "pB", rank: 2 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA", "pB"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pA")).toBe("rostered");
    expect(final.playerStatus.get("pB")).toBe("rostered");
    // pA on m1's roster only, pB on m2's roster only
    expect(final.rosters.get("m1")?.has("pA")).toBe(true);
    expect(final.rosters.get("m1")?.has("pB")).toBe(false);
    expect(final.rosters.get("m2")?.has("pB")).toBe(true);
    expect(final.rosters.get("m2")?.has("pA")).toBe(false);
  });
});

// ── Scenario: multi-award (one manager wins multiple players) ─────────────────

describe("multi-award: one manager wins multiple players", () => {
  it("all awarded players rostered, none double-owned — no violations", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", rank: 2 },
        { id: "c3", managerId: "m1", playerId: "pC", rank: 3 },
      ],
      rosters: { m1: [] },
      available: ["pA", "pB", "pC"],
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    for (const p of ["pA", "pB", "pC"]) {
      expect(final.playerStatus.get(p)).toBe("rostered");
    }
  });

  it("multi-award with drops: each drop goes on_waivers, acquired player rostered — no violations", () => {
    // m1 maxRosterSize=2, starts with [r1, r2]
    // rank 1: claim pA, drop r1 → net: [r2, pA]
    // rank 2: claim pB, drop r2 → net: [pA, pB]
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r1",
          rank: 1,
        },
        {
          id: "c2",
          managerId: "m1",
          playerId: "pB",
          dropPlayerId: "r2",
          rank: 2,
        },
      ],
      rosters: { m1: ["r1", "r2"] },
      available: ["pA", "pB"],
      maxRosterSize: 2,
    });
    const final = resolveAndApply(snap);
    expect(checkInvariant(final)).toHaveLength(0);
    expect(final.playerStatus.get("pA")).toBe("rostered");
    expect(final.playerStatus.get("pB")).toBe("rostered");
    expect(final.playerStatus.get("r1")).toBe("on_waivers");
    expect(final.playerStatus.get("r2")).toBe("on_waivers");
    expect(final.rosters.get("m1")).toEqual(new Set(["pA", "pB"]));
  });
});

// ── Property-style enumerated grid ───────────────────────────────────────────
//
// No fast-check available; enumerate a representative grid of configurations.
// Each covers a distinct axis: roster sizes, claim counts, drop presence,
// manager count, maxRosterSize. The invariant is checked on every output.

describe("property-style grid: all enumerated configurations maintain the invariant", () => {
  type Config = {
    label: string;
    snap: WaiverSnapshot;
    extraFreeAgents?: string[];
  };

  const CONFIGS: Config[] = [
    {
      label: "empty everything: no claims, no rosters, no available",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [],
        rosters: { m1: [] },
        available: [],
      }),
    },
    {
      label: "single award: m1 claims pA, wins",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
        rosters: { m1: [] },
        available: ["pA"],
      }),
    },
    {
      label: "no available players: all claims fail",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
          { id: "c2", managerId: "m2", playerId: "pB", rank: 1 },
        ],
        rosters: { m1: ["r1"], m2: ["r2"] },
        available: [],
      }),
    },
    {
      label: "roster full no drop: invalid claim, player stays on_waivers",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
        rosters: { m1: ["r1"] },
        available: ["pA"],
        maxRosterSize: 1,
      }),
    },
    {
      label: "conditional drop with full roster",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          {
            id: "c1",
            managerId: "m1",
            playerId: "pA",
            dropPlayerId: "r1",
            rank: 1,
          },
        ],
        rosters: { m1: ["r1"] },
        available: ["pA"],
        maxRosterSize: 1,
      }),
    },
    {
      label: "two managers compete for one player",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pX", rank: 1 },
          { id: "c2", managerId: "m2", playerId: "pX", rank: 1 },
        ],
        rosters: { m1: [], m2: [] },
        available: ["pX"],
      }),
    },
    {
      label: "three managers, two available players, priority decides who gets what",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2], ["m3", 3]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
          { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
          { id: "c3", managerId: "m2", playerId: "pB", rank: 2 },
          { id: "c4", managerId: "m3", playerId: "pB", rank: 1 },
        ],
        rosters: { m1: [], m2: [], m3: [] },
        available: ["pA", "pB"],
      }),
    },
    {
      label: "multi-award: m1 wins two players sequentially",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
          { id: "c2", managerId: "m1", playerId: "pB", rank: 2 },
        ],
        rosters: { m1: [], m2: [] },
        available: ["pA", "pB"],
      }),
    },
    {
      label: "auto-void: shared drop, second claim voided",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          {
            id: "c1",
            managerId: "m1",
            playerId: "pA",
            dropPlayerId: "r1",
            rank: 1,
          },
          {
            id: "c2",
            managerId: "m1",
            playerId: "pB",
            dropPlayerId: "r1",
            rank: 2,
          },
        ],
        rosters: { m1: ["r1"] },
        available: ["pA", "pB"],
        maxRosterSize: 1,
      }),
    },
    {
      label: "drop player not on roster (space available): drop is no-op",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          {
            id: "c1",
            managerId: "m1",
            playerId: "pA",
            dropPlayerId: "r99",
            rank: 1,
          },
        ],
        rosters: { m1: [] },
        available: ["pA"],
      }),
    },
    {
      label: "drop player not on roster AND roster full: invalid claim",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          {
            id: "c1",
            managerId: "m1",
            playerId: "pA",
            dropPlayerId: "r99",
            rank: 1,
          },
        ],
        rosters: { m1: ["r1"] },
        available: ["pA"],
        maxRosterSize: 1,
      }),
    },
    {
      label: "four managers, mixed claims, some with drops",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2], ["m3", 3], ["m4", 4]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
          {
            id: "c2",
            managerId: "m2",
            playerId: "pA",
            dropPlayerId: "r2",
            rank: 1,
          },
          { id: "c3", managerId: "m2", playerId: "pB", rank: 2 },
          { id: "c4", managerId: "m3", playerId: "pC", rank: 1 },
          { id: "c5", managerId: "m4", playerId: "pC", rank: 1 },
          { id: "c6", managerId: "m4", playerId: "pD", rank: 2 },
        ],
        rosters: { m1: [], m2: ["r2"], m3: [], m4: [] },
        available: ["pA", "pB", "pC", "pD"],
        maxRosterSize: 2,
      }),
    },
    {
      label: "all managers have full rosters, all claims invalid",
      snap: makeSnapshot({
        priority: [["m1", 1], ["m2", 2]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
          { id: "c2", managerId: "m2", playerId: "pB", rank: 1 },
        ],
        rosters: { m1: ["r1", "r2"], m2: ["r3", "r4"] },
        available: ["pA", "pB"],
        maxRosterSize: 2,
      }),
    },
    {
      label: "multi-award with consecutive drops (chain scenario)",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          {
            id: "c1",
            managerId: "m1",
            playerId: "pA",
            dropPlayerId: "r1",
            rank: 1,
          },
          {
            id: "c2",
            managerId: "m1",
            playerId: "pB",
            dropPlayerId: "r2",
            rank: 2,
          },
        ],
        rosters: { m1: ["r1", "r2"] },
        available: ["pA", "pB"],
        maxRosterSize: 2,
      }),
    },
    {
      label: "player extended (not in available): claim fails, no ownership change",
      snap: makeSnapshot({
        priority: [["m1", 1]],
        claims: [
          { id: "c1", managerId: "m1", playerId: "pExtended", rank: 1 },
        ],
        rosters: { m1: [] },
        available: [], // pExtended excluded (waiver extended to next round)
      }),
      extraFreeAgents: [],
    },
  ];

  for (const { label, snap, extraFreeAgents } of CONFIGS) {
    it(label, () => {
      const final = resolveAndApply(snap, extraFreeAgents);
      const violations = checkInvariant(final);
      expect(violations, violations.join("; ")).toHaveLength(0);
    });
  }
});
