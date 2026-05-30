import { describe, it, expect } from "vitest";
import {
  scorePlayer,
  applyCaptainMultiplier,
  type PlayerMatchStats,
  type FantasyPosition,
} from "./engine";

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

const ALL_POSITIONS: FantasyPosition[] = ["GK", "DEF", "MID", "FWD"];

// ── Appearance points ─────────────────────────────────────────────────────────

describe("appearance points", () => {
  it.each<[number, number]>([
    [0,  0],
    [1,  1],
    [59, 1],
  ])("minutesPlayed=%i → %i pts (all positions)", (minutes, expected) => {
    for (const pos of ALL_POSITIONS) {
      expect(scorePlayer({ ...ZERO, minutesPlayed: minutes }, pos)).toBe(expected);
    }
  });

  it.each<[number]>([[60], [90]])(
    "minutesPlayed=%i → 2 appearance pts (conceded=1 isolates from CS; floor(1/2)=0 penalty)",
    (minutes) => {
      for (const pos of ALL_POSITIONS) {
        // concededWhileOnPitch=1 prevents CS bonus; conceded penalty floor(1/2)=0 for GK/DEF
        expect(scorePlayer({ ...ZERO, minutesPlayed: minutes, concededWhileOnPitch: 1 }, pos)).toBe(2);
      }
    }
  );
});

// ── Goals scored ──────────────────────────────────────────────────────────────

describe("goal scored (isolated, 0 min so no appearance or clean-sheet)", () => {
  it.each<[FantasyPosition, number]>([
    ["GK",  10],
    ["DEF",  6],
    ["MID",  5],
    ["FWD",  4],
  ])("%s: 1 goal = %i pts", (pos, expected) => {
    expect(scorePlayer({ ...ZERO, goals: 1 }, pos)).toBe(expected);
  });

  it("2 goals doubles correctly for each position", () => {
    const single = (pos: FantasyPosition) => scorePlayer({ ...ZERO, goals: 1 }, pos);
    const double = (pos: FantasyPosition) => scorePlayer({ ...ZERO, goals: 2 }, pos);
    for (const pos of ALL_POSITIONS) {
      expect(double(pos)).toBe(2 * single(pos));
    }
  });
});

// ── Assists ───────────────────────────────────────────────────────────────────

describe("assists (all positions, 3 pts each)", () => {
  for (const pos of ALL_POSITIONS) {
    it(`${pos}: 1 assist = 3 pts`, () => {
      expect(scorePlayer({ ...ZERO, assists: 1 }, pos)).toBe(3);
    });
  }
});

// ── Clean sheet ───────────────────────────────────────────────────────────────

describe("clean sheet", () => {
  it.each<[FantasyPosition, number]>([
    ["GK",  4],
    ["DEF", 4],
    ["MID", 1],
    ["FWD", 0],
  ])("%s: 60+ min, 0 conceded, no red → clean sheet = %i", (pos, csBonus) => {
    // 2 appearance + clean sheet bonus
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90 }, pos)).toBe(2 + csBonus);
  });

  it.each(ALL_POSITIONS)("%s: 59 min, 0 conceded → no clean sheet (minutes < 60)", (pos) => {
    // 1 appearance, no clean sheet regardless of position
    expect(scorePlayer({ ...ZERO, minutesPlayed: 59 }, pos)).toBe(1);
  });

  it.each<[FantasyPosition, number]>([
    ["GK",  -1 + 2], // 2 appearance - 1 penalty (2 conceded)
    ["DEF", -1 + 2],
    ["MID",  0 + 2], // MID unaffected by conceded
    ["FWD",  0 + 2], // FWD unaffected
  ])("%s: 60+ min, 2 conceded → no clean sheet + conceded penalty", (pos, expected) => {
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90, concededWhileOnPitch: 2 }, pos)).toBe(expected);
  });

  it("clean sheet boundary: exactly 60 min, 0 conceded, no red", () => {
    expect(scorePlayer({ ...ZERO, minutesPlayed: 60 }, "GK")).toBe(2 + 4);  // appearance + CS
    expect(scorePlayer({ ...ZERO, minutesPlayed: 60 }, "DEF")).toBe(2 + 4);
    expect(scorePlayer({ ...ZERO, minutesPlayed: 60 }, "MID")).toBe(2 + 1);
    expect(scorePlayer({ ...ZERO, minutesPlayed: 60 }, "FWD")).toBe(2 + 0);
  });
});

// ── Red card voids clean sheet but not appearance ─────────────────────────────

describe("red card voids clean sheet, keeps appearance points", () => {
  it("GK 90 min, 0 conceded, 1 red → -1 (2 appearance - 3 red, 0 clean sheet)", () => {
    // From §6 clarifications example
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90, redCards: 1 }, "GK")).toBe(-1);
  });

  it.each(ALL_POSITIONS)("%s 90 min, 0 conceded, 1 red → 2 appearance + 0 CS - 3 = -1", (pos) => {
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90, redCards: 1 }, pos)).toBe(-1);
  });

  it("red card with < 60 min has no clean sheet to void, still subtracts 3", () => {
    // 45 min → 1 appearance, no CS eligible, red -3 → -2
    expect(scorePlayer({ ...ZERO, minutesPlayed: 45, redCards: 1 }, "DEF")).toBe(-2);
  });

  it("red card is independent of yellow card points", () => {
    // 90 min, yellow + red: 2 appearance - 1 yellow - 3 red - 0 CS = -2
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90, yellowCards: 1, redCards: 1 }, "MID")).toBe(-2);
  });
});

// ── Goals conceded penalty ────────────────────────────────────────────────────

describe("goals conceded penalty", () => {
  it.each<[number, number]>([
    [0, 0],
    [1, 0],
    [2, -1],
    [3, -1],
    [4, -2],
  ])("GK: %i conceded → %i penalty pts (isolated, 0 min)", (conceded, expected) => {
    expect(scorePlayer({ ...ZERO, concededWhileOnPitch: conceded }, "GK")).toBe(expected);
  });

  it.each<[number, number]>([
    [0, 0],
    [1, 0],
    [2, -1],
    [3, -1],
    [4, -2],
  ])("DEF: %i conceded → %i penalty pts (isolated, 0 min)", (conceded, expected) => {
    expect(scorePlayer({ ...ZERO, concededWhileOnPitch: conceded }, "DEF")).toBe(expected);
  });

  it.each<[number, number]>([
    [0, 0],
    [2, 0],
    [4, 0],
  ])("MID: %i conceded → 0 pts (unaffected)", (conceded, expected) => {
    expect(scorePlayer({ ...ZERO, concededWhileOnPitch: conceded }, "MID")).toBe(expected);
  });

  it.each<[number, number]>([
    [0, 0],
    [2, 0],
    [4, 0],
  ])("FWD: %i conceded → 0 pts (unaffected)", (conceded, expected) => {
    expect(scorePlayer({ ...ZERO, concededWhileOnPitch: conceded }, "FWD")).toBe(expected);
  });
});

// ── Saves ─────────────────────────────────────────────────────────────────────

describe("saves bonus (GK only)", () => {
  it.each<[number, number]>([
    [0, 0],
    [2, 0],
    [3, 1],
    [5, 1],
    [6, 2],
  ])("GK: %i saves → %i pts (isolated, 0 min)", (saves, expected) => {
    expect(scorePlayer({ ...ZERO, saves }, "GK")).toBe(expected);
  });

  it.each<FantasyPosition>(["DEF", "MID", "FWD"])("%s: saves ignored", (pos) => {
    expect(scorePlayer({ ...ZERO, saves: 6 }, pos)).toBe(0);
  });
});

// ── Penalty saved ─────────────────────────────────────────────────────────────

describe("penalty saved (GK only, 5 pts each)", () => {
  it("GK: 1 penalty saved = 5 pts", () => {
    expect(scorePlayer({ ...ZERO, penaltiesSaved: 1 }, "GK")).toBe(5);
  });

  it("GK: 2 penalties saved = 10 pts", () => {
    expect(scorePlayer({ ...ZERO, penaltiesSaved: 2 }, "GK")).toBe(10);
  });

  it.each<FantasyPosition>(["DEF", "MID", "FWD"])("%s: penalty saved ignored", (pos) => {
    expect(scorePlayer({ ...ZERO, penaltiesSaved: 1 }, pos)).toBe(0);
  });
});

// ── Penalty missed ────────────────────────────────────────────────────────────

describe("penalty missed (-2 pts, all positions)", () => {
  for (const pos of ALL_POSITIONS) {
    it(`${pos}: 1 penalty missed = -2 pts`, () => {
      expect(scorePlayer({ ...ZERO, penaltiesMissed: 1 }, pos)).toBe(-2);
    });
  }
});

// ── Yellow card ───────────────────────────────────────────────────────────────

describe("yellow card (-1 pt, all positions)", () => {
  for (const pos of ALL_POSITIONS) {
    it(`${pos}: 1 yellow card = -1 pt`, () => {
      expect(scorePlayer({ ...ZERO, yellowCards: 1 }, pos)).toBe(-1);
    });
  }
});

// ── Red card ──────────────────────────────────────────────────────────────────

describe("red card (-3 pts, all positions)", () => {
  for (const pos of ALL_POSITIONS) {
    it(`${pos}: 1 red card = -3 pts (isolated, 0 min)`, () => {
      expect(scorePlayer({ ...ZERO, redCards: 1 }, pos)).toBe(-3);
    });
  }
});

// ── Own goal ──────────────────────────────────────────────────────────────────

describe("own goal (-2 pts each, all positions)", () => {
  for (const pos of ALL_POSITIONS) {
    it(`${pos}: 1 own goal = -2 pts`, () => {
      expect(scorePlayer({ ...ZERO, ownGoals: 1 }, pos)).toBe(-2);
    });
  }

  it("2 own goals = -4 pts", () => {
    expect(scorePlayer({ ...ZERO, ownGoals: 2 }, "DEF")).toBe(-4);
  });
});

// ── Captain multiplier ────────────────────────────────────────────────────────

describe("applyCaptainMultiplier", () => {
  it("doubles points when captain", () => {
    expect(applyCaptainMultiplier(10, true)).toBe(20);
  });

  it("leaves points unchanged when not captain", () => {
    expect(applyCaptainMultiplier(10, false)).toBe(10);
  });

  it("works on negative points", () => {
    expect(applyCaptainMultiplier(-3, true)).toBe(-6);
  });

  it("works on zero", () => {
    expect(applyCaptainMultiplier(0, true)).toBe(0);
  });

  it("composite: GK captain with 20 base pts → 40", () => {
    // 90 min, 1 goal, 1 assist, 0 conceded, 3 saves
    // = 2 appearance + 10 goal + 3 assist + 4 CS + 1 saves = 20
    const base = scorePlayer(
      { ...ZERO, minutesPlayed: 90, goals: 1, assists: 1, concededWhileOnPitch: 0, saves: 3 },
      "GK"
    );
    expect(base).toBe(20);
    expect(applyCaptainMultiplier(base, true)).toBe(40);
  });
});

// ── Full composite lines (hand-computed from §6) ──────────────────────────────

describe("composite — GK", () => {
  it("90 min, 2 goals, 1 assist, 0 conceded, 7 saves, 1 pen saved → 36", () => {
    // 2 appearance + 20 goals + 3 assist + 4 CS + floor(7/3)=2 saves + 5 pen saved = 36
    expect(
      scorePlayer(
        { ...ZERO, minutesPlayed: 90, goals: 2, assists: 1, concededWhileOnPitch: 0, saves: 7, penaltiesSaved: 1 },
        "GK"
      )
    ).toBe(36);
  });

  it("60 min, 0 goals, 0 assist, 3 conceded, 2 saves, 0 pen saved, 1 yellow → -2", () => {
    // 2 appearance + 0 + 0 + 0 CS(conceded>0) + 0 saves + 0 - floor(3/2)=1 conceded - 1 yellow = -0
    // = 2 - 1 - 1 = 0 ... wait let me recompute
    // 2 appearance
    // 0 goals, 0 assists
    // clean sheet: no (conceded=3)
    // saves: floor(2/3) = 0
    // conceded penalty: floor(3/2) = 1 → -1
    // yellow: -1
    // total: 2 - 1 - 1 = 0
    expect(
      scorePlayer(
        { ...ZERO, minutesPlayed: 60, concededWhileOnPitch: 3, saves: 2, yellowCards: 1 },
        "GK"
      )
    ).toBe(0);
  });
});

describe("composite — DEF", () => {
  it("75 min, 1 goal, 1 assist, 1 conceded, 1 pen missed, 1 yellow, 1 own goal → 6", () => {
    // 2 appearance + 6 goal + 3 assist + 0 CS(conceded>0) + 0 conceded penalty(floor(1/2)=0) - 2 pen missed - 1 yellow - 2 own goal
    // = 2 + 6 + 3 - 2 - 1 - 2 = 6
    expect(
      scorePlayer(
        {
          ...ZERO,
          minutesPlayed: 75,
          goals: 1,
          assists: 1,
          concededWhileOnPitch: 1,
          penaltiesMissed: 1,
          yellowCards: 1,
          ownGoals: 1,
        },
        "DEF"
      )
    ).toBe(6);
  });

  it("90 min, 0 goals, 0 assist, 0 conceded, 0 cards → 6 (clean sheet)", () => {
    // 2 appearance + 4 CS = 6
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90 }, "DEF")).toBe(6);
  });
});

describe("composite — MID", () => {
  it("45 min, 1 goal, 2 assists, 3 conceded → 12", () => {
    // 1 appearance + 5 goal + 6 assists + 0 CS(<60 min) + 0 conceded(MID unaffected)
    // = 1 + 5 + 6 = 12
    expect(
      scorePlayer(
        { ...ZERO, minutesPlayed: 45, goals: 1, assists: 2, concededWhileOnPitch: 3 },
        "MID"
      )
    ).toBe(12);
  });

  it("60 min, 0 goals, 0 assists, 0 conceded → 3 (appearance + MID CS bonus)", () => {
    // 2 appearance + 1 CS = 3
    expect(scorePlayer({ ...ZERO, minutesPlayed: 60 }, "MID")).toBe(3);
  });
});

describe("composite — FWD", () => {
  it("60 min, 2 goals, 0 assists, 0 conceded, 1 pen missed → 8", () => {
    // 2 appearance + 8 goals + 0 CS(FWD=0) - 2 pen missed = 8
    expect(
      scorePlayer(
        { ...ZERO, minutesPlayed: 60, goals: 2, concededWhileOnPitch: 0, penaltiesMissed: 1 },
        "FWD"
      )
    ).toBe(8);
  });

  it("90 min, 0 goals, 0 assists, 0 conceded → 2 (FWD gets no CS bonus)", () => {
    // 2 appearance, CS pts = 0 for FWD
    expect(scorePlayer({ ...ZERO, minutesPlayed: 90 }, "FWD")).toBe(2);
  });

  it("30 min, 1 goal, 1 own goal → 3", () => {
    // 1 appearance + 4 goal - 2 own goal = 3
    expect(
      scorePlayer({ ...ZERO, minutesPlayed: 30, goals: 1, ownGoals: 1 }, "FWD")
    ).toBe(3);
  });
});
