import { describe, it, expect } from "vitest";
import {
  scoreStartingXI,
  type LineupPlayer,
  type StartingXIInput,
} from "./lineup";
import { type PlayerMatchStats, type FantasyPosition } from "./engine";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ZERO: PlayerMatchStats = {
  minutesPlayed: 0,
  goals: 0,
  assists: 0,
  concededWhileOnPitch: 0,
  saves: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  ownGoals: 0,
};

// Standard 4-4-2 positions. p01=GK p02-p05=DEF p06-p09=MID p10-p11=FWD
const STD_POSITIONS: FantasyPosition[] = [
  "GK",
  "DEF", "DEF", "DEF", "DEF",
  "MID", "MID", "MID", "MID",
  "FWD", "FWD",
];

const STD_IDS = STD_POSITIONS.map((_, i) => `p${String(i + 1).padStart(2, "0")}`);
// p01 … p11

function stdXI(
  statOverrides: Partial<Record<string, Partial<PlayerMatchStats>>> = {}
): LineupPlayer[] {
  return STD_IDS.map((id, i) => ({
    playerId: id,
    position: STD_POSITIONS[i],
    stats: { ...ZERO, ...statOverrides[id] },
  }));
}

function makeInput(opts: {
  statOverrides?: Partial<Record<string, Partial<PlayerMatchStats>>>;
  captainId?: string;
  vcId?: string | null;
}): StartingXIInput {
  return {
    players: stdXI(opts.statOverrides),
    captainId: opts.captainId ?? "p01",
    vcId: opts.vcId !== undefined ? opts.vcId : "p02",
  };
}

// ── Captain plays, VC set ─────────────────────────────────────────────────────

describe("captain plays 60+ min, VC set → captain 2x", () => {
  it("captain gets multiplier 2, VC gets multiplier 1", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 90 }, p02: { minutesPlayed: 90 } },
    });
    const result = scoreStartingXI(input);

    const cap = result.players.find(p => p.playerId === "p01")!;
    const vc  = result.players.find(p => p.playerId === "p02")!;

    expect(cap.multiplier).toBe(2);
    expect(cap.isCaptain).toBe(true);
    expect(vc.multiplier).toBe(1);
    expect(vc.isViceCaptain).toBe(true);
  });

  it("captain finalPoints === 2 × basePoints", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 90 } }, // GK, 90 min, 0 conceded → base = 6
    });
    const result = scoreStartingXI(input);
    const cap = result.players.find(p => p.playerId === "p01")!;

    expect(cap.finalPoints).toBe(cap.basePoints * 2);
  });

  it("all other players have multiplier 1", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 90 } },
    });
    const result = scoreStartingXI(input);
    const others = result.players.filter(p => p.playerId !== "p01");
    for (const p of others) expect(p.multiplier).toBe(1);
  });
});

// ── Captain plays 0 min, VC set → VC 2x ──────────────────────────────────────

describe("captain plays 0 min, VC set → VC promotes to 2x", () => {
  it("VC gets multiplier 2, captain gets multiplier 1", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 0 }, p02: { minutesPlayed: 90 } },
    });
    const result = scoreStartingXI(input);

    const cap = result.players.find(p => p.playerId === "p01")!;
    const vc  = result.players.find(p => p.playerId === "p02")!;

    expect(cap.multiplier).toBe(1);
    expect(vc.multiplier).toBe(2);
  });

  it("original designations isCaptain/isViceCaptain are preserved regardless of promotion", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 0 }, p02: { minutesPlayed: 90 } },
    });
    const result = scoreStartingXI(input);

    const cap = result.players.find(p => p.playerId === "p01")!;
    const vc  = result.players.find(p => p.playerId === "p02")!;

    // Designations are unchanged even though captain didn't play
    expect(cap.isCaptain).toBe(true);
    expect(cap.isViceCaptain).toBe(false);
    expect(vc.isCaptain).toBe(false);
    expect(vc.isViceCaptain).toBe(true);
  });

  it("promoted VC finalPoints === 2 × basePoints", () => {
    // p02 is DEF, 90 min, 0 conceded → base = 2 + 4 = 6 → final = 12
    const input = makeInput({
      statOverrides: { p02: { minutesPlayed: 90 } },
    });
    const result = scoreStartingXI(input);
    const vc = result.players.find(p => p.playerId === "p02")!;

    expect(vc.basePoints).toBe(6);
    expect(vc.finalPoints).toBe(12);
  });

  it("promotion triggers on captain's 0 minutes regardless of VC minutes (VC also plays 0)", () => {
    // Both captain and VC play 0 min; VC still promotes (2x of 0 = 0)
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 0 }, p02: { minutesPlayed: 0 } },
    });
    const result = scoreStartingXI(input);

    const cap = result.players.find(p => p.playerId === "p01")!;
    const vc  = result.players.find(p => p.playerId === "p02")!;

    expect(cap.multiplier).toBe(1);
    expect(vc.multiplier).toBe(2);
    expect(vc.basePoints).toBe(0);
    expect(vc.finalPoints).toBe(0);
  });
});

// ── Captain plays 0 min, no VC → captain 1x, no promotion ────────────────────

describe("captain plays 0 min, no VC → captain 1x, no promotion", () => {
  it("captain multiplier is 1 (not 2x)", () => {
    const input = makeInput({
      statOverrides: { p01: { minutesPlayed: 0 } },
      vcId: null,
    });
    const result = scoreStartingXI(input);
    const cap = result.players.find(p => p.playerId === "p01")!;

    expect(cap.multiplier).toBe(1);
    expect(cap.isCaptain).toBe(true);
  });

  it("no player has multiplier 2", () => {
    const input = makeInput({ vcId: null });
    const result = scoreStartingXI(input);
    const twoX = result.players.filter(p => p.multiplier === 2);
    expect(twoX).toHaveLength(0);
  });

  it("isViceCaptain is false for all players when vcId is null", () => {
    const input = makeInput({ vcId: null });
    const result = scoreStartingXI(input);
    for (const p of result.players) expect(p.isViceCaptain).toBe(false);
  });
});

// ── total === sum of finalPoints ──────────────────────────────────────────────

describe("total integrity", () => {
  it("total equals sum of all finalPoints", () => {
    const input = makeInput({
      statOverrides: {
        p01: { minutesPlayed: 90 },
        p02: { minutesPlayed: 90, goals: 1 },
        p10: { minutesPlayed: 60, goals: 2 },
      },
    });
    const result = scoreStartingXI(input);
    const summed = result.players.reduce((s, p) => s + p.finalPoints, 0);
    expect(result.total).toBe(summed);
  });

  it("total is consistent across captain/VC promotion scenarios", () => {
    // VC promotion case: same players, captain plays 0
    const promoted = makeInput({
      statOverrides: { p01: { minutesPlayed: 0 }, p02: { minutesPlayed: 90 } },
    });
    const r = scoreStartingXI(promoted);
    expect(r.total).toBe(r.players.reduce((s, p) => s + p.finalPoints, 0));
  });
});

// ── Defensive assertions ──────────────────────────────────────────────────────

describe("defensive assertions", () => {
  it("throws when captainId is not in XI", () => {
    const input: StartingXIInput = {
      players: stdXI(),
      captainId: "not-in-xi",
      vcId: "p02",
    };
    expect(() => scoreStartingXI(input)).toThrow("not-in-xi");
  });

  it("throws when vcId is non-null but not in XI", () => {
    const input: StartingXIInput = {
      players: stdXI(),
      captainId: "p01",
      vcId: "not-in-xi",
    };
    expect(() => scoreStartingXI(input)).toThrow("not-in-xi");
  });

  it("does NOT throw when vcId is null (absent VC is valid)", () => {
    const input: StartingXIInput = {
      players: stdXI(),
      captainId: "p01",
      vcId: null,
    };
    expect(() => scoreStartingXI(input)).not.toThrow();
  });
});

// ── Mixed XI composite ────────────────────────────────────────────────────────

describe("composite — realistic XI with per-position stats", () => {
  // Hand-computed expected scores (§6 table):
  //   p01 GK (captain): 90 min, 0 conceded, 6 saves → 2 app + 4 CS + 2 saves = 8 base → 16 final (2x)
  //   p02 DEF (VC):     90 min, 0 conceded, 1 assist → 2 + 4 + 3 = 9
  //   p03 DEF:          90 min, 0 conceded → 6
  //   p04 DEF:          90 min, 2 conceded → 2 - 1 conceded = 1  (no CS, conceded penalty)
  //   p05 DEF:          90 min, 0 conceded, 1 goal → 2 + 4 + 6 = 12
  //   p06 MID:          90 min, 0 conceded, 1 goal, 1 assist → 2 + 1 + 5 + 3 = 11
  //   p07 MID:          90 min, 0 conceded → 3
  //   p08 MID:          45 min, 1 yellow → 1 - 1 = 0
  //   p09 MID:          90 min, 0 conceded, 1 pen missed → 2 + 1 - 2 = 1
  //   p10 FWD:          90 min, 2 goals → 2 + 8 = 10   (FWD: 0 CS)
  //   p11 FWD:          30 min, 1 goal, 1 own goal → 1 + 4 - 2 = 3
  //
  // total = 16 + 9 + 6 + 1 + 12 + 11 + 3 + 0 + 1 + 10 + 3 = 72

  const COMPOSITE_INPUT: StartingXIInput = {
    captainId: "p01",
    vcId: "p02",
    players: [
      { playerId: "p01", position: "GK",  stats: { ...ZERO, minutesPlayed: 90, saves: 6 } },
      { playerId: "p02", position: "DEF", stats: { ...ZERO, minutesPlayed: 90, assists: 1 } },
      { playerId: "p03", position: "DEF", stats: { ...ZERO, minutesPlayed: 90 } },
      { playerId: "p04", position: "DEF", stats: { ...ZERO, minutesPlayed: 90, concededWhileOnPitch: 2 } },
      { playerId: "p05", position: "DEF", stats: { ...ZERO, minutesPlayed: 90, goals: 1 } },
      { playerId: "p06", position: "MID", stats: { ...ZERO, minutesPlayed: 90, goals: 1, assists: 1 } },
      { playerId: "p07", position: "MID", stats: { ...ZERO, minutesPlayed: 90 } },
      { playerId: "p08", position: "MID", stats: { ...ZERO, minutesPlayed: 45, yellowCards: 1 } },
      { playerId: "p09", position: "MID", stats: { ...ZERO, minutesPlayed: 90, penaltiesMissed: 1 } },
      { playerId: "p10", position: "FWD", stats: { ...ZERO, minutesPlayed: 90, goals: 2 } },
      { playerId: "p11", position: "FWD", stats: { ...ZERO, minutesPlayed: 30, goals: 1, ownGoals: 1 } },
    ],
  };

  it("exactly one player has multiplier 2 (the captain)", () => {
    const result = scoreStartingXI(COMPOSITE_INPUT);
    const twoX = result.players.filter(p => p.multiplier === 2);
    expect(twoX).toHaveLength(1);
    expect(twoX[0].playerId).toBe("p01");
  });

  it("total is 72", () => {
    const result = scoreStartingXI(COMPOSITE_INPUT);
    expect(result.total).toBe(72);
  });

  it("per-player basePoints match §6 hand computation", () => {
    const result = scoreStartingXI(COMPOSITE_INPUT);
    const byId = Object.fromEntries(result.players.map(p => [p.playerId, p]));

    expect(byId.p01.basePoints).toBe(8);   // GK 2+4+2
    expect(byId.p02.basePoints).toBe(9);   // DEF 2+4+3
    expect(byId.p03.basePoints).toBe(6);   // DEF 2+4
    expect(byId.p04.basePoints).toBe(1);   // DEF 2-1
    expect(byId.p05.basePoints).toBe(12);  // DEF 2+4+6
    expect(byId.p06.basePoints).toBe(11);  // MID 2+1+5+3
    expect(byId.p07.basePoints).toBe(3);   // MID 2+1
    expect(byId.p08.basePoints).toBe(0);   // MID 1-1
    expect(byId.p09.basePoints).toBe(1);   // MID 2+1-2
    expect(byId.p10.basePoints).toBe(10);  // FWD 2+8
    expect(byId.p11.basePoints).toBe(3);   // FWD 1+4-2
  });

  it("captain (p01) finalPoints is 2× basePoints", () => {
    const result = scoreStartingXI(COMPOSITE_INPUT);
    const cap = result.players.find(p => p.playerId === "p01")!;
    expect(cap.finalPoints).toBe(cap.basePoints * 2);
  });

  it("total equals sum of finalPoints", () => {
    const result = scoreStartingXI(COMPOSITE_INPUT);
    expect(result.total).toBe(result.players.reduce((s, p) => s + p.finalPoints, 0));
  });

  describe("VC promotion variant: captain (GK) plays 0, VC (p02) promotes", () => {
    const PROMOTED = { ...COMPOSITE_INPUT, players: COMPOSITE_INPUT.players.map(p =>
      p.playerId === "p01" ? { ...p, stats: { ...p.stats, minutesPlayed: 0 } } : p
    )};

    it("p02 VC has multiplier 2, p01 captain has multiplier 1", () => {
      const result = scoreStartingXI(PROMOTED);
      const cap = result.players.find(p => p.playerId === "p01")!;
      const vc  = result.players.find(p => p.playerId === "p02")!;
      expect(cap.multiplier).toBe(1);
      expect(vc.multiplier).toBe(2);
    });

    it("original badges preserved: p01 isCaptain, p02 isViceCaptain", () => {
      const result = scoreStartingXI(PROMOTED);
      expect(result.players.find(p => p.playerId === "p01")!.isCaptain).toBe(true);
      expect(result.players.find(p => p.playerId === "p02")!.isViceCaptain).toBe(true);
    });
  });
});
