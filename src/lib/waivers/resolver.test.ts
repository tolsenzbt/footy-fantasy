import { describe, it, expect } from "vitest";
import {
  processWaivers,
  type WaiverSnapshot,
  type WaiverPriorityEntry,
  type WaiverClaim,
  type WaiverTransaction,
} from "./resolver";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(opts: {
  priority: Array<[string, number]>; // [managerId, priority]
  claims: Array<{
    id: string;
    managerId: string;
    playerId: string;
    dropPlayerId?: string;
    rank: number;
  }>;
  rosters: Record<string, string[]>; // managerId -> playerIds
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

function awardsFor(transactions: WaiverTransaction[], managerId: string) {
  return transactions.filter(
    (t) => t.type === "award" && t.managerId === managerId
  );
}

function byType<T extends WaiverTransaction["type"]>(
  transactions: WaiverTransaction[],
  type: T
): Extract<WaiverTransaction, { type: T }>[] {
  return transactions.filter(
    (t): t is Extract<WaiverTransaction, { type: T }> => t.type === type
  );
}

// ── Single claim award ────────────────────────────────────────────────────────

describe("single claim award", () => {
  it("awards the claim and removes player from available", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "p1", rank: 1 }],
      rosters: { m1: [] },
      available: ["p1"],
    });
    const result = processWaivers(snap);
    const award = result.transactions.find((t) => t.type === "award");
    expect(award).toBeDefined();
    expect((award as { playerId: string }).playerId).toBe("p1");
    expect(result.transactions).toHaveLength(1);
  });

  it("manager moves to bottom after award (single manager stays at bottom)", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "p1", rank: 1 }],
      rosters: { m1: [] },
      available: ["p1"],
    });
    const { finalPriorityOrder } = processWaivers(snap);
    expect(finalPriorityOrder).toHaveLength(1);
    expect(finalPriorityOrder[0].managerId).toBe("m1");
  });

  it("no claim → empty transactions, priority unchanged", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [],
      rosters: { m1: [] },
      available: ["p1"],
    });
    const result = processWaivers(snap);
    expect(result.transactions).toHaveLength(0);
    expect(result.finalPriorityOrder[0].priority).toBe(1);
  });
});

// ── Priority-based competition ────────────────────────────────────────────────

describe("priority-based competition: two managers claim same player", () => {
  it("higher-priority manager wins, lower-priority claim fails", () => {
    const snap = makeSnapshot({
      priority: [
        ["m1", 1], // highest
        ["m2", 2],
      ],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA"],
    });
    const result = processWaivers(snap);
    const award = byType(result.transactions, "award");
    const fail = byType(result.transactions, "fail");

    expect(award).toHaveLength(1);
    expect(award[0].managerId).toBe("m1");
    expect(fail).toHaveLength(1);
    expect(fail[0].managerId).toBe("m2");
  });

  it("winning manager moves to bottom of priority", () => {
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
    const { finalPriorityOrder } = processWaivers(snap);
    const ordered = [...finalPriorityOrder].sort(
      (a, b) => a.priority - b.priority
    );
    expect(ordered[0].managerId).toBe("m2");
    expect(ordered[1].managerId).toBe("m1");
  });
});

// ── Fixpoint: low-priority wins unpopular player ──────────────────────────────

describe("fixpoint: low-priority manager wins player nobody else wants", () => {
  it("m1 claims pA (popular), m2 claims pB and pA; m1 wins pA, m2 wins pB", () => {
    // m1 priority 1, claims pA only
    // m2 priority 2, claims pA (rank 1) and pB (rank 2)
    // Pass 1: m1 wins pA (→ bottom). m2's rank-1 claim pA is gone → m2 wins pB.
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
    const result = processWaivers(snap);
    const awards = byType(result.transactions, "award");
    expect(awards).toHaveLength(2);

    const m1Award = awards.find((t) => t.managerId === "m1");
    const m2Award = awards.find((t) => t.managerId === "m2");
    expect(m1Award?.playerId).toBe("pA");
    expect(m2Award?.playerId).toBe("pB");
  });

  it("m2's pA claim is marked fail after pA is taken", () => {
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
    const result = processWaivers(snap);
    const fails = byType(result.transactions, "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0].claimId).toBe("c2");
  });
});

// ── Ranked claims sharing one drop (auto-void) ────────────────────────────────

describe("ranked claims sharing one conditional drop (auto-void)", () => {
  // m1 has roster [r1], maxRosterSize = 1 (full)
  // rank-1: claim pA, drop r1
  // rank-2: claim pB, drop r1
  // Both pA and pB are available.
  // rank-1 awarded → r1 dropped → rank-2 auto-voided (drop already used)

  it("rank-1 awarded; rank-2 voided because shared drop was used", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", dropPlayerId: "r1", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", dropPlayerId: "r1", rank: 2 },
      ],
      rosters: { m1: ["r1"] },
      available: ["pA", "pB"],
      maxRosterSize: 1,
    });
    const result = processWaivers(snap);
    const award = byType(result.transactions, "award");
    const voids = byType(result.transactions, "void");

    expect(award).toHaveLength(1);
    expect(award[0].playerId).toBe("pA");
    expect(award[0].dropPlayerId).toBe("r1");

    expect(voids).toHaveLength(1);
    expect(voids[0].claimId).toBe("c2");
    expect(voids[0].reason).toBe("drop_already_used");
  });

  it("auto-void does not cost an extra priority penalty beyond the single award", () => {
    // m1 wins pA (moves to bottom once), c2 is auto-voided (no extra move).
    // m2 wins pC (moves to bottom after m1).
    // Final order sorted ascending: m1 went to bottom first (slot N) → m2 went
    // to bottom last (slot N+1) → m1 has lower priority number → m1 is ahead of m2.
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", dropPlayerId: "r1", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", dropPlayerId: "r1", rank: 2 },
        { id: "c3", managerId: "m2", playerId: "pC", rank: 1 },
      ],
      rosters: { m1: ["r1"], m2: [] },
      available: ["pA", "pB", "pC"],
      maxRosterSize: 1,
    });
    const { finalPriorityOrder } = processWaivers(snap);
    const ordered = [...finalPriorityOrder].sort(
      (a, b) => a.priority - b.priority
    );
    // m1 dropped to bottom first, m2 second → m1 has lower (better) priority number
    expect(ordered[0].managerId).toBe("m1");
    expect(ordered[1].managerId).toBe("m2");
  });
});

// ── Multi-win ─────────────────────────────────────────────────────────────────

describe("multi-win: one manager can win multiple players", () => {
  it("manager claims two separate players; both awarded", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", rank: 2 },
        // m2 has no competing claims
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA", "pB"],
    });
    const result = processWaivers(snap);
    const m1Awards = awardsFor(result.transactions, "m1");
    expect(m1Awards).toHaveLength(2);
    const playerIds = m1Awards.map((t) => (t as { playerId: string }).playerId);
    expect(playerIds).toContain("pA");
    expect(playerIds).toContain("pB");
  });

  it("after first award manager drops to bottom; second award if no one else wants it", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", rank: 2 },
        { id: "c3", managerId: "m2", playerId: "pC", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA", "pB", "pC"],
    });
    const result = processWaivers(snap);
    expect(byType(result.transactions, "award")).toHaveLength(3);
    expect(awardsFor(result.transactions, "m1")).toHaveLength(2);
    expect(awardsFor(result.transactions, "m2")).toHaveLength(1);
  });
});

// ── Full roster, no drop = invalid, no priority cost ─────────────────────────

describe("full roster, no drop → invalid, no priority cost", () => {
  it("claim marked invalid when roster full and no drop specified", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const result = processWaivers(snap);
    const invalids = byType(result.transactions, "invalid");
    expect(invalids).toHaveLength(1);
    expect(invalids[0].reason).toBe("roster_full_no_drop");
    expect(byType(result.transactions, "award")).toHaveLength(0);
  });

  it("invalid claim does not change priority order", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pA", rank: 1 }],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const { finalPriorityOrder } = processWaivers(snap);
    const m1 = finalPriorityOrder.find((e) => e.managerId === "m1")!;
    const m2 = finalPriorityOrder.find((e) => e.managerId === "m2")!;
    expect(m1.priority).toBeLessThan(m2.priority); // m1 still ahead of m2
  });
});

// ── Conditional drop ──────────────────────────────────────────────────────────

describe("conditional drop: roster full, drop player on roster → creates space", () => {
  it("award executed and drop player removed from effective roster", () => {
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
    const result = processWaivers(snap);
    const award = byType(result.transactions, "award")[0];
    expect(award).toBeDefined();
    expect((award as { playerId: string }).playerId).toBe("pA");
    expect((award as { dropPlayerId: string }).dropPlayerId).toBe("r1");
  });

  it("drop not on roster + roster full → invalid with reason drop_not_on_roster", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r99", // not on roster
          rank: 1,
        },
      ],
      rosters: { m1: ["r1"] },
      available: ["pA"],
      maxRosterSize: 1,
    });
    const result = processWaivers(snap);
    const invalids = byType(result.transactions, "invalid");
    expect(invalids).toHaveLength(1);
    expect(invalids[0].reason).toBe("drop_not_on_roster");
  });

  it("drop not on roster but roster has space → still awards (drop ignored)", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [
        {
          id: "c1",
          managerId: "m1",
          playerId: "pA",
          dropPlayerId: "r99", // not on roster
          rank: 1,
        },
      ],
      rosters: { m1: [] }, // roster has space
      available: ["pA"],
      maxRosterSize: 1,
    });
    const result = processWaivers(snap);
    const award = byType(result.transactions, "award")[0];
    expect(award).toBeDefined();
    // dropPlayerId is null in the award transaction because drop wasn't executed
    expect((award as { dropPlayerId: string | null }).dropPlayerId).toBeNull();
  });
});

// ── Exit conditions ───────────────────────────────────────────────────────────

describe("exit conditions: terminates when no more awards possible", () => {
  it("terminates with all claims failed when no players available", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pB", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: [], // nothing on waivers
    });
    const result = processWaivers(snap);
    expect(byType(result.transactions, "award")).toHaveLength(0);
    expect(byType(result.transactions, "fail")).toHaveLength(2);
  });

  it("terminates when all managers have invalid claims (full roster, no drop)", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pB", rank: 1 },
      ],
      rosters: { m1: ["r1"], m2: ["r2"] },
      available: ["pA", "pB"],
      maxRosterSize: 1,
    });
    const result = processWaivers(snap);
    expect(byType(result.transactions, "award")).toHaveLength(0);
    expect(byType(result.transactions, "invalid")).toHaveLength(2);
  });
});

// ── Invariant checks ──────────────────────────────────────────────────────────

describe("invariants", () => {
  it("each claim ID appears in exactly one transaction", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", rank: 2 },
        { id: "c3", managerId: "m2", playerId: "pA", rank: 1 },
        { id: "c4", managerId: "m2", playerId: "pC", rank: 2 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA", "pB", "pC"],
    });
    const result = processWaivers(snap);
    const ids = result.transactions.map((t) => t.claimId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.sort()).toEqual(["c1", "c2", "c3", "c4"].sort());
  });

  it("finalPriorityOrder contains same manager IDs as input, no duplicates", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2], ["m3", 3]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m3", playerId: "pB", rank: 1 },
      ],
      rosters: { m1: [], m2: [], m3: [] },
      available: ["pA", "pB"],
    });
    const { finalPriorityOrder } = processWaivers(snap);
    expect(finalPriorityOrder).toHaveLength(3);
    const ids = finalPriorityOrder.map((e) => e.managerId).sort();
    expect(ids).toEqual(["m1", "m2", "m3"].sort());

    const priorities = finalPriorityOrder.map((e) => e.priority);
    expect(new Set(priorities).size).toBe(3); // all unique
  });

  it("awarded players are not double-awarded", () => {
    const snap = makeSnapshot({
      priority: [["m1", 1], ["m2", 2]],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", rank: 1 },
        { id: "c2", managerId: "m2", playerId: "pA", rank: 1 },
      ],
      rosters: { m1: [], m2: [] },
      available: ["pA"],
    });
    const result = processWaivers(snap);
    const awards = byType(result.transactions, "award");
    const awardedPlayers = awards.map(
      (t) => (t as { playerId: string }).playerId
    );
    expect(new Set(awardedPlayers).size).toBe(awardedPlayers.length);
  });
});

// ── Waiver extension: player not yet eligible ─────────────────────────────────

describe("waiver extension: player not in availablePlayers is not processed", () => {
  it("claim for unavailable player marked fail regardless of roster state", () => {
    // If a player's waiver is extended to a future round, the cron handler
    // excludes them from availablePlayers. The resolver marks the claim as fail.
    const snap = makeSnapshot({
      priority: [["m1", 1]],
      claims: [{ id: "c1", managerId: "m1", playerId: "pExtended", rank: 1 }],
      rosters: { m1: [] },
      available: [], // pExtended excluded because nation kicked off before processing
    });
    const result = processWaivers(snap);
    expect(byType(result.transactions, "fail")).toHaveLength(1);
    expect(result.transactions[0].claimId).toBe("c1");
  });
});

// ── Regression: manager absent from roster map respects maxRosterSize ─────────
// Before the fix (line ~104), `effectiveRosters.get(managerId) ?? new Set()` created
// a throwaway Set on every lookup, so a manager absent from snapshot.rosters always
// appeared to have 0 players and could be awarded without bound.

describe("regression: manager absent from snapshot.rosters obeys maxRosterSize", () => {
  it("manager with no roster map entry is awarded at most maxRosterSize players", () => {
    // m1 is intentionally absent from the rosters Map (not even an empty Set).
    // It has 3 ranked claims and maxRosterSize=2.
    // Before the fix: all 3 would be awarded (size always 0).
    // After the fix: only 2 awarded (size accumulates correctly).
    const snapshot: WaiverSnapshot = {
      priorityOrder: [{ managerId: "m1", priority: 1 }],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", dropPlayerId: null, rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", dropPlayerId: null, rank: 2 },
        { id: "c3", managerId: "m1", playerId: "pC", dropPlayerId: null, rank: 3 },
      ],
      rosters: new Map(), // m1 is absent — not even present with an empty Set
      availablePlayers: new Set(["pA", "pB", "pC"]),
      maxRosterSize: 2,
    };

    const result = processWaivers(snapshot);
    const awards = byType(result.transactions, "award");
    expect(awards.length).toBeLessThanOrEqual(2);
    expect(awards).toHaveLength(2); // exactly 2: pA and pB
  });

  it("second player awarded fills the slot created by first award (accumulation check)", () => {
    const snapshot: WaiverSnapshot = {
      priorityOrder: [{ managerId: "m1", priority: 1 }],
      claims: [
        { id: "c1", managerId: "m1", playerId: "pA", dropPlayerId: null, rank: 1 },
        { id: "c2", managerId: "m1", playerId: "pB", dropPlayerId: null, rank: 2 },
      ],
      rosters: new Map(),
      availablePlayers: new Set(["pA", "pB"]),
      maxRosterSize: 1,
    };

    const result = processWaivers(snapshot);
    const awards = byType(result.transactions, "award");
    expect(awards).toHaveLength(1);
    expect(awards[0].playerId).toBe("pA"); // only first (highest-ranked) claim wins
  });
});
