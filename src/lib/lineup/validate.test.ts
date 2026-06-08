import { describe, it, expect } from "vitest";

// validate.ts imports "server-only" — stub it before the import below.
import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { validateLineup, type RosterPlayer, type PreviousLineup, type LineupSubmission } from "./validate";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// 14-player roster for a 4-4-2: 1GK + 4DEF + 4MID + 2FWD starters, 3 bench.
const roster: RosterPlayer[] = [
  { playerId: "p01", position: "GK",  nationKickoffAt: null },
  { playerId: "p02", position: "DEF", nationKickoffAt: null },
  { playerId: "p03", position: "DEF", nationKickoffAt: null },
  { playerId: "p04", position: "DEF", nationKickoffAt: null },
  { playerId: "p05", position: "DEF", nationKickoffAt: null },
  { playerId: "p06", position: "MID", nationKickoffAt: null },
  { playerId: "p07", position: "MID", nationKickoffAt: null },
  { playerId: "p08", position: "MID", nationKickoffAt: null },
  { playerId: "p09", position: "MID", nationKickoffAt: null },
  { playerId: "p10", position: "FWD", nationKickoffAt: null },
  { playerId: "p11", position: "FWD", nationKickoffAt: null },
  { playerId: "p12", position: "GK",  nationKickoffAt: null },
  { playerId: "p13", position: "MID", nationKickoffAt: null },
  { playerId: "p14", position: "FWD", nationKickoffAt: null },
];

const STARTERS = ["p01","p02","p03","p04","p05","p06","p07","p08","p09","p10","p11"];
const BENCH    = ["p12","p13","p14"];

const validSub: LineupSubmission = {
  formation: "4-4-2",
  starterPlayerIds: STARTERS,
  benchPlayerIds: BENCH,
  captainPlayerId: "p01",
  vcPlayerId: "p02",
};

const NOW = new Date("2026-06-01T10:00:00Z");
const PAST = new Date("2026-06-01T09:00:00Z");
const FUTURE = new Date("2026-06-01T11:00:00Z");

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path", () => {
  it("passes with no previous lineup", () => {
    expect(validateLineup(validSub, roster, null, NOW)).toEqual({ ok: true });
  });

  it("passes with a previous lineup that has no locked slots", () => {
    const prev: PreviousLineup = {
      captainPlayerId: "p01",
      vcPlayerId: "p02",
      captainLockedAt: null,
      vcLockedAt: null,
      slots: [
        ...STARTERS.map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: null as Date | null })),
        ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
      ],
    };
    expect(validateLineup(validSub, roster, prev, NOW)).toEqual({ ok: true });
  });
});

// ── Rule 1: total count ───────────────────────────────────────────────────────

describe("rule 1 — total count", () => {
  it("fails with 13 players", () => {
    const sub = { ...validSub, benchPlayerIds: BENCH.slice(0, 2) };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("14") });
  });

  it("fails with 15 players", () => {
    const sub = { ...validSub, benchPlayerIds: [...BENCH, "p01"] };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false });
  });
});

// ── Rule 2: roster membership & uniqueness ────────────────────────────────────

describe("rule 2 — roster & uniqueness", () => {
  it("fails if a player is not on the roster", () => {
    const sub = { ...validSub, starterPlayerIds: [...STARTERS.slice(0, 10), "stranger"] };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("stranger") });
  });

  it("fails if a player appears twice", () => {
    const sub = {
      ...validSub,
      starterPlayerIds: ["p01", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09", "p10"],
      benchPlayerIds: ["p11", "p12", "p13"],
    };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Duplicate") });
  });
});

// ── Rule 3: 11 starters / 3 bench ────────────────────────────────────────────

describe("rule 3 — 11 starters / 3 bench", () => {
  it("fails with 10 starters and 4 bench", () => {
    const sub = {
      ...validSub,
      starterPlayerIds: STARTERS.slice(0, 10),
      benchPlayerIds: [...BENCH, "p11"],
    };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("11 starters") });
  });
});

// ── Rule 4: formation match ───────────────────────────────────────────────────

describe("rule 4 — formation", () => {
  it("fails for an invalid formation string", () => {
    const sub = { ...validSub, formation: "4-2-4" };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Invalid formation") });
  });

  it("fails when starter positions don't match formation", () => {
    // Formation says 4-3-3 but starters are 4-4-2
    const sub = { ...validSub, formation: "4-3-3" };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("don't match") });
  });
});

// ── Rule 5: captain in starting XI ───────────────────────────────────────────

describe("rule 5 — captain in starting XI", () => {
  it("fails when captain is on bench", () => {
    const sub = { ...validSub, captainPlayerId: "p12" }; // p12 is bench
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Captain") });
  });
});

// ── Rule 6: VC in starting XI and ≠ captain ──────────────────────────────────

describe("rule 6 — VC", () => {
  it("fails when VC is on bench", () => {
    const sub = { ...validSub, vcPlayerId: "p13" };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Vice-captain") });
  });

  it("fails when captain and VC are the same player", () => {
    const sub = { ...validSub, vcPlayerId: "p01" };
    const r = validateLineup(sub, roster, null, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("different") });
  });
});

// ── Rule 7a: locked slot enforcement ─────────────────────────────────────────

describe("rule 7a — locked slot", () => {
  const prevWithLock: PreviousLineup = {
    captainPlayerId: "p01",
    vcPlayerId: "p02",
    captainLockedAt: null,
    vcLockedAt: null,
    slots: [
      { playerId: "p01", slotType: "starter", lockedAt: PAST }, // locked
      ...STARTERS.slice(1).map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: null })),
      ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null })),
    ],
  };

  it("fails when a locked starter is moved to bench", () => {
    // Swap p01 (locked starter) to bench, put p12 in starting XI
    // Captain is p12 (now in starters) so rule 5 doesn't fire before rule 7a
    const newStarters = ["p12", ...STARTERS.slice(1)];
    const newBench = ["p01", "p13", "p14"];
    const sub = {
      ...validSub,
      formation: "4-4-2",
      starterPlayerIds: newStarters,
      benchPlayerIds: newBench,
      captainPlayerId: "p12",
      vcPlayerId: "p02",
    };
    const r = validateLineup(sub, roster, prevWithLock, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("locked as starter") });
  });

  it("fails when a locked player is removed from lineup", () => {
    // Replace p01 with p12 in lineup entirely (drop p01)
    const newStarters = ["p12", ...STARTERS.slice(1)];
    const newBench = ["p13", "p14", "p02"];
    const sub = { ...validSub, formation: "4-3-3", starterPlayerIds: newStarters, benchPlayerIds: newBench };
    const r = validateLineup(sub, roster, prevWithLock, NOW);
    // p01 locked and not in submission
    expect(r).toMatchObject({ ok: false });
  });

  it("passes when locked starter remains as starter", () => {
    const r = validateLineup(validSub, roster, prevWithLock, NOW);
    expect(r).toEqual({ ok: true });
  });

  it("locks by nationKickoffAt even when lockedAt is null in DB", () => {
    // p01 has no DB lock but its nation's match kicked off (nationKickoffAt in past)
    const rosterWithKickoff = roster.map(r =>
      r.playerId === "p01" ? { ...r, nationKickoffAt: PAST } : r
    );
    const prevNoDbLock: PreviousLineup = {
      captainPlayerId: "p01",
      vcPlayerId: "p02",
      captainLockedAt: null,
      vcLockedAt: null,
      slots: [
        ...STARTERS.map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: null as Date | null })),
        ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
      ],
    };
    // Try to move p01 to bench; captain is p12 (now in starters) to avoid rule 5 firing first
    const newStarters = ["p12", ...STARTERS.slice(1)];
    const newBench = ["p01", "p13", "p14"];
    const sub = {
      ...validSub,
      starterPlayerIds: newStarters,
      benchPlayerIds: newBench,
      captainPlayerId: "p12",
      vcPlayerId: "p02",
    };
    const r = validateLineup(sub, rosterWithKickoff, prevNoDbLock, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("locked as starter") });
  });
});

// ── Rule 7b: captain lock ─────────────────────────────────────────────────────

describe("rule 7b — captain lock", () => {
  const prevCaptainLocked: PreviousLineup = {
    captainPlayerId: "p01",
    vcPlayerId: "p02",
    captainLockedAt: PAST,
    vcLockedAt: null,
    slots: [
      ...STARTERS.map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: PAST as Date | null })),
      ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
    ],
  };

  it("fails when trying to change a locked captain", () => {
    const sub = { ...validSub, captainPlayerId: "p02", vcPlayerId: "p03" };
    const r = validateLineup(sub, roster, prevCaptainLocked, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Captain is locked") });
  });

  it("passes when keeping the locked captain", () => {
    const r = validateLineup(validSub, roster, prevCaptainLocked, NOW);
    expect(r).toEqual({ ok: true });
  });
});

// ── Rule 7c: VC lock ──────────────────────────────────────────────────────────

describe("rule 7c — VC lock", () => {
  const prevVcLocked: PreviousLineup = {
    captainPlayerId: "p01",
    vcPlayerId: "p02",
    captainLockedAt: null,
    vcLockedAt: PAST,
    slots: [
      ...STARTERS.map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: PAST as Date | null })),
      ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
    ],
  };

  it("fails when trying to change a locked VC", () => {
    const sub = { ...validSub, vcPlayerId: "p03" };
    const r = validateLineup(sub, roster, prevVcLocked, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Vice-captain is locked") });
  });

  it("passes when keeping the locked VC", () => {
    const r = validateLineup(validSub, roster, prevVcLocked, NOW);
    expect(r).toEqual({ ok: true });
  });
});

// ── Rule 8: new captain/VC can't be locked player ────────────────────────────

describe("rule 8 — new captain/VC can't be locked player", () => {
  it("fails when designating a locked player as new captain", () => {
    // p02 is locked (DB lock), p01 is not previously captain
    const prev: PreviousLineup = {
      captainPlayerId: "p03",
      vcPlayerId: "p04",
      captainLockedAt: null,
      vcLockedAt: null,
      slots: [
        ...STARTERS.map(id => ({
          playerId: id,
          slotType: "starter" as const,
          lockedAt: (id === "p02" ? PAST : null) as Date | null,
        })),
        ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
      ],
    };
    // Try to make p02 (locked) the new captain
    const sub = { ...validSub, captainPlayerId: "p02", vcPlayerId: "p01" };
    const r = validateLineup(sub, roster, prev, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("locked player as captain") });
  });

  it("fails when designating a locked player as new VC", () => {
    const prev: PreviousLineup = {
      captainPlayerId: "p01",
      vcPlayerId: "p03",
      captainLockedAt: null,
      vcLockedAt: null,
      slots: [
        ...STARTERS.map(id => ({
          playerId: id,
          slotType: "starter" as const,
          lockedAt: (id === "p02" ? PAST : null) as Date | null,
        })),
        ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
      ],
    };
    // Try to make p02 (locked) the new VC
    const sub = { ...validSub, vcPlayerId: "p02" };
    const r = validateLineup(sub, roster, prev, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("locked player as vice-captain") });
  });

  it("passes when keeping same captain who happens to be locked", () => {
    const prev: PreviousLineup = {
      captainPlayerId: "p01",
      vcPlayerId: "p02",
      captainLockedAt: null,
      vcLockedAt: null,
      slots: [
        ...STARTERS.map(id => ({
          playerId: id,
          slotType: "starter" as const,
          lockedAt: (id === "p01" ? PAST : null) as Date | null,
        })),
        ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null as Date | null })),
      ],
    };
    // p01 is locked but we're NOT changing the captain designation
    const r = validateLineup(validSub, roster, prev, NOW);
    expect(r).toEqual({ ok: true });
  });
});
