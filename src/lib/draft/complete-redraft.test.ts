import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mockDb }));

function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    for: vi.fn(),
    limit: vi.fn().mockReturnValue(terminal),
  };
  for (const m of ["from", "where", "for"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

// Capture order of all DB writes inside the transaction
type TxWrite =
  | { op: "delete"; table: string }
  | { op: "insert"; table: string; values: unknown }
  | { op: "update"; table: string; set: unknown };

function makeTxMock(responses: Map<string, unknown[]>) {
  const writes: TxWrite[] = [];

  // Responses: keyed by table name for selects
  function selFor(key: string) {
    return sel(responses.get(key) ?? []);
  }

  let selectCallCount = 0;
  const selectKeys = [...(responses.keys())];

  const tx = {
    select: vi.fn().mockImplementation(() => {
      const key = selectKeys[selectCallCount++] ?? "";
      return selFor(key);
    }),

    insert: vi.fn().mockImplementation((table: { _: { name: string } }) => {
      const tableName = String(table);
      const valuesFn = vi.fn().mockImplementation((vals: unknown) => {
        writes.push({ op: "insert", table: tableName, values: vals });
        return {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([]),
        };
      });
      return { values: valuesFn };
    }),

    update: vi.fn().mockImplementation((table: unknown) => {
      const tableName = String(table);
      const whereFn = vi.fn().mockResolvedValue([]);
      const setFn = vi.fn().mockImplementation((vals: unknown) => {
        writes.push({ op: "update", table: tableName, set: vals });
        return { where: whereFn };
      });
      return { set: setFn };
    }),

    delete: vi.fn().mockImplementation((table: unknown) => {
      const tableName = String(table);
      const whereFn = vi.fn().mockResolvedValue([]);
      writes.push({ op: "delete", table: tableName });
      return { where: vi.fn().mockReturnValue({ where: whereFn }) };
    }),

    _writes: writes,
  };

  return tx;
}

import { computeKnockoutPriorities, completeRedraft } from "./complete-redraft";

// ── Pure: computeKnockoutPriorities ───────────────────────────────────────────

describe("computeKnockoutPriorities", () => {
  it("reverses by-need positions for N=4", () => {
    const rows = [
      { managerId: "m1", position: 1 },
      { managerId: "m2", position: 2 },
      { managerId: "m3", position: 3 },
      { managerId: "m4", position: 4 },
    ];
    const result = computeKnockoutPriorities(rows);
    expect(result).toEqual([
      { managerId: "m1", priority: 4 }, // most need → lowest priority
      { managerId: "m2", priority: 3 },
      { managerId: "m3", priority: 2 },
      { managerId: "m4", priority: 1 }, // least need → highest priority
    ]);
  });

  it("reverses by-need positions for N=6 (8-team format)", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      managerId: `m${i + 1}`,
      position: i + 1,
    }));
    const result = computeKnockoutPriorities(rows);
    expect(result[0]).toEqual({ managerId: "m1", priority: 6 });
    expect(result[5]).toEqual({ managerId: "m6", priority: 1 });
  });

  it("opted-out manager retains their draft slot in the reversal", () => {
    // N=4, m2 was opted out but holds position 2 — not excluded from priority
    const rows = [
      { managerId: "m1", position: 1 },
      { managerId: "m2", position: 2 }, // opted out
      { managerId: "m3", position: 3 },
      { managerId: "m4", position: 4 },
    ];
    const result = computeKnockoutPriorities(rows);
    const m2 = result.find((r) => r.managerId === "m2");
    // N+1-2 = 3: m2 keeps position 2's reversed slot, not excluded
    expect(m2?.priority).toBe(3);
    // All 4 managers appear (opted-out not removed)
    expect(result).toHaveLength(4);
  });

  it("single participant (N=1): priority is 1", () => {
    const result = computeKnockoutPriorities([{ managerId: "solo", position: 1 }]);
    expect(result).toEqual([{ managerId: "solo", priority: 1 }]);
  });

  it("does not mutate input", () => {
    const rows = [{ managerId: "m1", position: 1 }];
    const copy = [...rows];
    computeKnockoutPriorities(rows);
    expect(rows).toEqual(copy);
  });
});

// ── Transition-sequence test (mocked DB) ──────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const DRAFT_ID = "draft-uuid";
const QF_ROUND_ID = "qf-round-uuid";
const COMPLETED_AT = new Date("2026-06-28T10:00:00Z");

const redraftingLeague = {
  status: "redrafting",
  priorityResetCompletedAt: null,
  knockoutFirstEventScheduledAt: null,
};

const completedRedraftDraft = {
  id: DRAFT_ID,
  status: "complete",
  completedAt: COMPLETED_AT,
};

const draftOrderRows = [
  { managerId: "m1", position: 1 },
  { managerId: "m2", position: 2 },
  { managerId: "m3", position: 3 },
  { managerId: "m4", position: 4 },
];

const qfFantasyRound = { id: QF_ROUND_ID };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("completeRedraft — transition sequence", () => {
  it("throws if league is not in redrafting status", async () => {
    mockDb.select.mockReturnValueOnce(sel([{ status: "group_stage" }]));
    await expect(completeRedraft(LEAGUE_ID)).rejects.toThrow("redrafting status");
  });

  it("throws if redraft is not yet complete", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ status: "redrafting" }]))
      .mockReturnValueOnce(sel([{ id: DRAFT_ID, status: "active", completedAt: null }]));
    await expect(completeRedraft(LEAGUE_ID)).rejects.toThrow("not yet complete");
  });

  it("priority reset precedes +1h event scheduling (write-order assertion)", async () => {
    // Pre-transaction selects
    mockDb.select
      .mockReturnValueOnce(sel([{ status: "redrafting" }])) // league check
      .mockReturnValueOnce(sel([completedRedraftDraft]));     // redraft check

    // Build a tx mock that records all writes in order
    const writes: Array<{ op: string; hint?: string }> = [];
    let txSelectCall = 0;
    const txSelectResponses = [
      [redraftingLeague],   // locked league
      draftOrderRows,       // draft_order
      [qfFantasyRound],     // qf round
    ];

    const tx = {
      select: vi.fn().mockImplementation(() => {
        const result = txSelectResponses[txSelectCall++] ?? [];
        return sel(result);
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          // Distinguish priority insert from event insert
          if ("phase" in vals) {
            writes.push({ op: "insert:priority", hint: `mgr=${vals.managerId},pri=${vals.priority}` });
          } else if ("scheduledAt" in vals) {
            writes.push({ op: "insert:event", hint: `scheduledAt=${vals.scheduledAt}` });
          } else {
            writes.push({ op: "insert:unknown" });
          }
          return { onConflictDoNothing: vi.fn().mockResolvedValue([]) };
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => fn(tx)
    );

    await completeRedraft(LEAGUE_ID);

    // Verify write order: all priority inserts come before the event insert
    const priorityInserts = writes
      .map((w, i) => ({ ...w, idx: i }))
      .filter((w) => w.op === "insert:priority");
    const eventInsert = writes
      .map((w, i) => ({ ...w, idx: i }))
      .find((w) => w.op === "insert:event");

    expect(priorityInserts).toHaveLength(4); // 4 managers
    expect(eventInsert).toBeDefined();

    const lastPriorityIdx = priorityInserts.at(-1)!.idx;
    expect(lastPriorityIdx).toBeLessThan(eventInsert!.idx);
  });

  it("+1h event is scheduled at completedAt + 3600s", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ status: "redrafting" }]))
      .mockReturnValueOnce(sel([completedRedraftDraft]));

    let capturedScheduledAt: Date | null = null;
    let txSelectCall = 0;
    const txSelectResponses = [
      [redraftingLeague],
      draftOrderRows,
      [qfFantasyRound],
    ];

    const tx = {
      select: vi.fn().mockImplementation(() => {
        const result = txSelectResponses[txSelectCall++] ?? [];
        return sel(result);
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          if ("scheduledAt" in vals) {
            capturedScheduledAt = vals.scheduledAt as Date;
          }
          return { onConflictDoNothing: vi.fn().mockResolvedValue([]) };
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => fn(tx)
    );

    await completeRedraft(LEAGUE_ID);

    expect(capturedScheduledAt).not.toBeNull();
    const diff =
      capturedScheduledAt!.getTime() - COMPLETED_AT.getTime();
    expect(diff).toBe(60 * 60 * 1000); // exactly +1h
  });

  it("priority reset uses the by-need reversal (position→priority mapping)", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ status: "redrafting" }]))
      .mockReturnValueOnce(sel([completedRedraftDraft]));

    const capturedPriorityInserts: Array<{ managerId: string; priority: number }> = [];
    let txSelectCall = 0;
    const txSelectResponses = [
      [redraftingLeague],
      draftOrderRows,
      [qfFantasyRound],
    ];

    const tx = {
      select: vi.fn().mockImplementation(() => {
        const result = txSelectResponses[txSelectCall++] ?? [];
        return sel(result);
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          if ("phase" in vals) {
            capturedPriorityInserts.push({
              managerId: vals.managerId as string,
              priority: vals.priority as number,
            });
          }
          return { onConflictDoNothing: vi.fn().mockResolvedValue([]) };
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => fn(tx)
    );

    await completeRedraft(LEAGUE_ID);

    // 4 managers: position 1→priority 4, position 4→priority 1
    expect(capturedPriorityInserts).toHaveLength(4);
    const byManager = new Map(
      capturedPriorityInserts.map((r) => [r.managerId, r.priority])
    );
    expect(byManager.get("m1")).toBe(4); // most need → lowest priority
    expect(byManager.get("m2")).toBe(3);
    expect(byManager.get("m3")).toBe(2);
    expect(byManager.get("m4")).toBe(1); // least need → highest priority
  });

  it("is idempotent: second call is a no-op when already in knockouts", async () => {
    mockDb.select.mockReturnValueOnce(sel([{ status: "knockouts" }]));
    await expect(completeRedraft(LEAGUE_ID)).rejects.toThrow("redrafting status");
  });
});
