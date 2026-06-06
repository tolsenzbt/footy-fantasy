import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deriveConcededWhileOnPitch,
  deriveAllPlayerRawStats,
  type ApiEvent,
  type ApiPlayerEntry,
  type ApiTeamPlayersEntry,
} from "./conceded";

// ─── Real fixture IDs ─────────────────────────────────────────────────────────
const QATAR_TEAM_ID = 1569;
const ECUADOR_TEAM_ID = 2382;
const MOROCCO_TEAM_ID = 46; // synthetic ID for 855767 tests
const CANADA_TEAM_ID = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGoal(
  teamId: number,
  elapsed: number,
  extra: number | null = null,
  detail = "Normal Goal",
  playerId = 99,
  assistId: number | null = null,
): ApiEvent {
  return {
    time: { elapsed, extra },
    team: { id: teamId, name: "" },
    player: { id: playerId, name: "" },
    assist: { id: assistId, name: null },
    type: "Goal",
    detail,
    comments: null,
  };
}

function makeSubst(teamId: number, elapsed: number, offId: number, onId: number): ApiEvent {
  return {
    time: { elapsed, extra: null },
    team: { id: teamId, name: "" },
    player: { id: offId, name: "" },
    assist: { id: onId, name: "" },
    type: "subst",
    detail: "Substitution 1",
    comments: null,
  };
}

function makeRedCard(teamId: number, elapsed: number, playerId: number): ApiEvent {
  return {
    time: { elapsed, extra: null },
    team: { id: teamId, name: "" },
    player: { id: playerId, name: "" },
    assist: { id: null, name: null },
    type: "Card",
    detail: "Red Card",
    comments: null,
  };
}

function makeVarGoalCancelled(teamId: number, elapsed: number): ApiEvent {
  return {
    time: { elapsed, extra: null },
    team: { id: teamId, name: "" },
    player: { id: 999, name: "" },
    assist: { id: null, name: null },
    type: "Var",
    detail: "Goal cancelled",
    comments: null,
  };
}

function makePlayer(
  id: number,
  substitute: boolean,
  minutes: number | null = 90,
  position = "D",
): ApiPlayerEntry {
  return {
    player: { id, name: `Player ${id}` },
    statistics: [
      {
        games: { minutes, number: id, position, rating: null, captain: false, substitute },
        goals: { total: null, conceded: null, assists: null, saves: null },
        cards: { yellow: 0, red: 0 },
        penalty: { won: null, commited: null, scored: 0, missed: 0, saved: 0 },
      },
    ],
  };
}

// ─── 855736 real event fixtures ───────────────────────────────────────────────
// Qatar 0–2 Ecuador: goals at 16' and 31', VAR goal-cancelled at 5', subs from 68'+

const REAL_EVENTS_855736: ApiEvent[] = [
  // VAR cancelled goal at 5' (Ecuador)
  makeVarGoalCancelled(ECUADOR_TEAM_ID, 5),
  // Goal 1: Ecuador 16' (penalty)
  makeGoal(ECUADOR_TEAM_ID, 16, null, "Penalty", 35533),
  // Goal 2: Ecuador 31' (normal)
  makeGoal(ECUADOR_TEAM_ID, 31, null, "Normal Goal", 35533, 2583),
  // Sub: Ecuador 68' — Ibarra (2585) off, Sarmiento (202086) on
  makeSubst(ECUADOR_TEAM_ID, 68, 2585, 202086),
  // Sub: Qatar 71' — Al Haydos (2545) off, Waad (42180) on
  makeSubst(QATAR_TEAM_ID, 71, 2545, 42180),
  // Sub: Qatar 72' — Almoez Ali (2543) off, Muntari (42089) on
  makeSubst(QATAR_TEAM_ID, 72, 2543, 42089),
  // Sub: Ecuador 77' — E. Valencia (35533) off, Cifuentes (16776) on
  makeSubst(ECUADOR_TEAM_ID, 77, 35533, 16776),
  // Sub: Ecuador 90' — Caicedo (116117) off, Franco (16360) on
  makeSubst(ECUADOR_TEAM_ID, 90, 116117, 16360),
  // Sub: Ecuador 90' — Estrada (16432) off, Rodriguez (361966) on
  makeSubst(ECUADOR_TEAM_ID, 90, 16432, 361966),
];

// Qatar starters (ids from players.json)
const QATAR_STARTER_IDS = [2525, 2530, 2536, 2532, 2527, 175439, 2545, 2537, 2533, 2543, 2544];
// Qatar subs
const QATAR_SUB_IDS = [42180, 42089];

function makeQatarPlayers(): ApiTeamPlayersEntry {
  const starterMinutes: Record<number, number> = {
    2545: 71, // subbed off at 71
    2543: 72, // subbed off at 72
  };
  const players = QATAR_STARTER_IDS.map((id) =>
    makePlayer(id, false, starterMinutes[id] ?? 90, id === 2525 ? "G" : "D")
  );
  // Qatar subs: 42180 (came on 71'), 42089 (came on 72') — all others never played
  players.push(makePlayer(42180, true, 19, "M"));
  players.push(makePlayer(42089, true, 18, "F"));
  // Remaining squad members who never entered
  for (const id of [42021, 2526, 2528, 42215, 2541, 200981, 42043, 182330, 2535, 42044, 42088, 42087, 2542]) {
    players.push(makePlayer(id, true, null, "D"));
  }
  return { team: { id: QATAR_TEAM_ID, name: "Qatar" }, players };
}

function makeEcuadorPlayers(): ApiTeamPlayersEntry {
  const starterMinutes: Record<number, number> = {
    2585: 68,   // subbed off at 68
    35533: 77,  // subbed off at 77
    116117: 89, // subbed off at 90 (1 minute remaining)
    16432: 89,
  };
  const starters = [16380, 2583, 63964, 127817, 46731, 16369, 2581, 116117, 2585, 35533, 16432];
  const players = starters.map((id) =>
    makePlayer(id, false, starterMinutes[id] ?? 90, id === 16380 ? "G" : "D")
  );
  // Ecuador subs
  players.push(makePlayer(202086, true, 22, "F")); // on at 68'
  players.push(makePlayer(16360, true, 1, "M"));   // on at 90'
  players.push(makePlayer(361966, true, 1, "M"));  // on at 90'
  players.push(makePlayer(16776, true, 13, "M"));  // on at 77'
  for (const id of [81224, 2568, 16367, 2575, 2571, 36784, 2572, 35786, 2577, 2586]) {
    players.push(makePlayer(id, true, null, "D"));
  }
  return { team: { id: ECUADOR_TEAM_ID, name: "Ecuador" }, players };
}

// ─── 855767 Morocco–Canada OG event ──────────────────────────────────────────
// Aguerd (Morocco, id=232) scored OG; event.team.id = Canada (beneficiary)
// Goal minute = 40'

const OG_EVENT_MOROCCO_CANADA: ApiEvent = {
  time: { elapsed: 40, extra: null },
  team: { id: CANADA_TEAM_ID, name: "Canada" }, // beneficiary = Canada
  player: { id: 232, name: "Aguerd" },           // scorer = Morocco player
  assist: { id: null, name: null },
  type: "Goal",
  detail: "Own Goal",
  comments: null,
};

function makeMoroccoPlayers(): ApiTeamPlayersEntry {
  return {
    team: { id: MOROCCO_TEAM_ID, name: "Morocco" },
    players: [
      makePlayer(232, false, 90),  // Aguerd — starter, full match
      makePlayer(233, false, 90),  // another Morocco starter
      makePlayer(500, true, 50),   // sub who came on at 40' (after the OG)
    ],
  };
}

function makeCanadaPlayers(): ApiTeamPlayersEntry {
  return {
    team: { id: CANADA_TEAM_ID, name: "Canada" },
    players: [
      makePlayer(300, false, 90), // Canada starter
      makePlayer(301, false, 90), // Canada starter
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deriveConcededWhileOnPitch", () => {
  describe("855736 Qatar 0–2 Ecuador", () => {
    const qatarPlayers = makeQatarPlayers();
    const ecuadorPlayers = makeEcuadorPlayers();
    const allPlayers = [qatarPlayers, ecuadorPlayers];

    it("Qatar starters who played full match concede 2", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      // Full 90-min Qatar starters: GK 2525, DEFs 2530 2536 2532 2527 175439, MIDs 2537 2533, FWD 2544
      for (const id of [2525, 2530, 2536, 2532, 2527, 175439, 2537, 2533, 2544]) {
        expect(result.get(id), `Qatar player ${id}`).toBe(2);
      }
    });

    it("Qatar starter subbed off at 71' (Al Haydos 2545) concedes 2 — both goals before sub", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      // Interval [0, 71). Goals at 16 and 31 — both < 71. conceded=2.
      expect(result.get(2545)).toBe(2);
    });

    it("Qatar starter subbed off at 72' (Almoez Ali 2543) concedes 2 — both goals before sub", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      expect(result.get(2543)).toBe(2);
    });

    it("Qatar sub who came on at 71' (Waad 42180) concedes 0 — both goals before entering", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      // Interval [71, ∞). Goals at 16 and 31 — both < 71. conceded=0.
      expect(result.get(42180)).toBe(0);
    });

    it("Qatar sub who came on at 72' (Muntari 42089) concedes 0", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      expect(result.get(42089)).toBe(0);
    });

    it("VAR-cancelled goal at 5' is NOT counted (type=Var)", () => {
      // If VAR goal were counted, Qatar starters would show 3. They should show 2.
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      expect(result.get(2525)).toBe(2); // not 3
    });

    it("Ecuador players concede 0 (Qatar never scored)", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      for (const id of [16380, 2583, 63964, 127817, 46731, 16369, 2581, 116117, 2585, 35533, 16432]) {
        expect(result.get(id), `Ecuador player ${id}`).toBe(0);
      }
    });

    it("players who never entered (null minutes, substitute=true) get 0", () => {
      const result = deriveConcededWhileOnPitch(
        REAL_EVENTS_855736, allPlayers, QATAR_TEAM_ID, ECUADOR_TEAM_ID
      );
      // Qatar squad members who never played
      for (const id of [42021, 2526, 2528]) {
        expect(result.get(id), `unused sub ${id}`).toBe(0);
      }
    });
  });

  describe("855767 Morocco–Canada — own goal", () => {
    const events = [OG_EVENT_MOROCCO_CANADA];
    const allPlayers = [makeMoroccoPlayers(), makeCanadaPlayers()];

    it("Morocco starters on at 40' concede +1 from the OG", () => {
      const result = deriveConcededWhileOnPitch(
        events, allPlayers, MOROCCO_TEAM_ID, CANADA_TEAM_ID
      );
      // Aguerd (232) and player 233 started from 0, interval [0, ∞). Goal at 40 ∈ [0, ∞). +1
      expect(result.get(232)).toBe(1);
      expect(result.get(233)).toBe(1);
    });

    it("Morocco sub who came on AFTER 40' concedes 0", () => {
      // Player 500: substitute=true, sub-on event would be needed to set onMin.
      // In this test there is no subst event, so onMin stays +Infinity → conceded=0.
      const result = deriveConcededWhileOnPitch(
        events, allPlayers, MOROCCO_TEAM_ID, CANADA_TEAM_ID
      );
      expect(result.get(500)).toBe(0);
    });

    it("Canada players get 0 — Canada scored the OG (beneficiary), not conceded", () => {
      const result = deriveConcededWhileOnPitch(
        events, allPlayers, MOROCCO_TEAM_ID, CANADA_TEAM_ID
      );
      expect(result.get(300)).toBe(0);
      expect(result.get(301)).toBe(0);
    });
  });

  describe("synthetic edge cases", () => {
    it("player subbed off BEFORE a goal is not charged", () => {
      const events: ApiEvent[] = [
        makeSubst(QATAR_TEAM_ID, 30, 2525, 42180), // GK off at 30'
        makeGoal(ECUADOR_TEAM_ID, 45),              // goal at 45'
      ];
      const players: ApiTeamPlayersEntry[] = [
        {
          team: { id: QATAR_TEAM_ID, name: "Qatar" },
          players: [
            makePlayer(2525, false, 30),  // starter subbed off at 30'
            makePlayer(42180, true, 60),  // came on at 30'
          ],
        },
        {
          team: { id: ECUADOR_TEAM_ID, name: "Ecuador" },
          players: [],
        },
      ];
      const result = deriveConcededWhileOnPitch(events, players, QATAR_TEAM_ID, ECUADOR_TEAM_ID);
      expect(result.get(2525)).toBe(0);  // subbed off before the goal
      expect(result.get(42180)).toBe(1); // on pitch at goal time
    });

    it("red card closes the interval — goal after red card is not charged", () => {
      const events: ApiEvent[] = [
        makeRedCard(QATAR_TEAM_ID, 50, 2525),  // red card at 50'
        makeGoal(ECUADOR_TEAM_ID, 70),          // goal at 70'
        makeGoal(ECUADOR_TEAM_ID, 80),          // goal at 80'
      ];
      const players: ApiTeamPlayersEntry[] = [
        {
          team: { id: QATAR_TEAM_ID, name: "Qatar" },
          players: [makePlayer(2525, false, 50, "G")],
        },
        {
          team: { id: ECUADOR_TEAM_ID, name: "Ecuador" },
          players: [],
        },
      ];
      const result = deriveConcededWhileOnPitch(events, players, QATAR_TEAM_ID, ECUADOR_TEAM_ID);
      expect(result.get(2525)).toBe(0); // red at 50', interval [0, 50), goals at 70 and 80 are outside
    });

    it("stoppage-time goal uses elapsed + extra for comparison", () => {
      // Goal at 90+3 = minute 93. Player on [0, 92) should NOT be charged; player on [0, ∞) should be.
      const events: ApiEvent[] = [
        makeSubst(QATAR_TEAM_ID, 92, 2525, 42180), // sub off at 90+2=92
        makeGoal(ECUADOR_TEAM_ID, 90, 3),            // goal at 90+3=93
      ];
      const players: ApiTeamPlayersEntry[] = [
        {
          team: { id: QATAR_TEAM_ID, name: "Qatar" },
          players: [
            makePlayer(2525, false, 92),
            makePlayer(42180, true, 1),
          ],
        },
        {
          team: { id: ECUADOR_TEAM_ID, name: "Ecuador" },
          players: [],
        },
      ];
      const result = deriveConcededWhileOnPitch(events, players, QATAR_TEAM_ID, ECUADOR_TEAM_ID);
      expect(result.get(2525)).toBe(0);  // off at 92, goal at 93 — not charged
      expect(result.get(42180)).toBe(1); // on at 92, goal at 93 — charged
    });
  });

  describe("validation guard — warns on minutes discrepancy", () => {
    it("logs a warning when derived duration diverges from API minutes by more than slack", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Player 2525 is a starter with offMin=45 (subbed off), but API says 80 minutes.
      // Discrepancy = 80 - 45 = 35 > slack → should warn.
      const events: ApiEvent[] = [
        makeSubst(QATAR_TEAM_ID, 45, 2525, 42180),
      ];
      const players: ApiTeamPlayersEntry[] = [
        {
          team: { id: QATAR_TEAM_ID, name: "Qatar" },
          players: [
            makePlayer(2525, false, 80),  // API says 80 but we derive sub-off at 45
            makePlayer(42180, true, 45),
          ],
        },
        { team: { id: ECUADOR_TEAM_ID, name: "Ecuador" }, players: [] },
      ];

      deriveConcededWhileOnPitch(events, players, QATAR_TEAM_ID, ECUADOR_TEAM_ID);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("discrepancy"));
      consoleSpy.mockRestore();
    });
  });
});

describe("deriveAllPlayerRawStats", () => {
  it("cleanSheet raw comes from API goals.conceded===0 (not our event count)", () => {
    // Ecuador GK Galindez (16380): API reports goals.conceded=0 and played 90 min.
    // Ecuador never conceded in this match, so API cleanSheet signal is correct.
    // Our event count also = 0. If API said conceded=0, cleanSheet=true.
    const qatarPlayers = makeQatarPlayers();
    const ecuadorPlayers = makeEcuadorPlayers();
    // Set API-reported conceded for Ecuador GK to 0 (they kept a clean sheet)
    const gk = ecuadorPlayers.players.find((p) => p.player.id === 16380)!;
    gk.statistics[0].goals.conceded = 0;

    const result = deriveAllPlayerRawStats(
      REAL_EVENTS_855736,
      [qatarPlayers, ecuadorPlayers],
      QATAR_TEAM_ID,
      ECUADOR_TEAM_ID
    );

    const gkStats = result.get(16380);
    expect(gkStats?.cleanSheet).toBe(true); // API conceded=0 + 90 min
  });

  it("cleanSheet false when API goals.conceded > 0, regardless of concededWhileOnPitch", () => {
    // Qatar GK (2525): API reports goals.conceded=2. Even if concededWhileOnPitch is derived as 0
    // (hypothetically), the raw cleanSheet field uses the API value.
    const qatarPlayers = makeQatarPlayers();
    const ecuadorPlayers = makeEcuadorPlayers();
    const gk = qatarPlayers.players.find((p) => p.player.id === 2525)!;
    gk.statistics[0].goals.conceded = 2;

    const result = deriveAllPlayerRawStats(
      REAL_EVENTS_855736,
      [qatarPlayers, ecuadorPlayers],
      QATAR_TEAM_ID,
      ECUADOR_TEAM_ID
    );

    expect(result.get(2525)?.cleanSheet).toBe(false);
  });

  it("penaltySaves and penaltiesMissed are stored as integer counts", () => {
    const qatarPlayers = makeQatarPlayers();
    const ecuadorPlayers = makeEcuadorPlayers();
    // Give Qatar GK 2 penalty saves and Ecuador captain 1 penalty miss
    const gk = qatarPlayers.players.find((p) => p.player.id === 2525)!;
    gk.statistics[0].penalty.saved = 2;
    const fwd = ecuadorPlayers.players.find((p) => p.player.id === 35533)!;
    fwd.statistics[0].penalty.missed = 1;

    const result = deriveAllPlayerRawStats(
      REAL_EVENTS_855736,
      [qatarPlayers, ecuadorPlayers],
      QATAR_TEAM_ID,
      ECUADOR_TEAM_ID
    );

    expect(result.get(2525)?.penaltySaves).toBe(2);
    expect(result.get(35533)?.penaltiesMissed).toBe(1);
  });

  it("null penalty/card fields from API are coerced to 0 (API returns null despite type claiming number)", () => {
    // Regression: API-Football returns null for penalty.saved, penalty.missed, cards.yellow, cards.red
    // when a player had none. The type claimed number but runtime reality is null.
    // deriveAllPlayerRawStats must coerce to 0 before passing to upsertPlayerMatchStats.
    const qatarPlayers = makeQatarPlayers();
    const gk = qatarPlayers.players.find((p) => p.player.id === 2525)!;
    // Simulate what the real API returns for a player with no penalties or cards
    gk.statistics[0].penalty.saved = null as unknown as number;
    gk.statistics[0].penalty.missed = null as unknown as number;
    gk.statistics[0].cards.yellow = null as unknown as number;
    gk.statistics[0].cards.red = null as unknown as number;

    const result = deriveAllPlayerRawStats(
      [],
      [qatarPlayers, { team: { id: ECUADOR_TEAM_ID, name: "Ecuador" }, players: [] }],
      QATAR_TEAM_ID,
      ECUADOR_TEAM_ID
    );

    const stats = result.get(2525);
    expect(stats?.penaltySaves).toBe(0);
    expect(stats?.penaltiesMissed).toBe(0);
    expect(stats?.yellowCards).toBe(0);
    expect(stats?.redCard).toBe(false);
  });

  it("ownGoals are derived from Goal events with detail=Own Goal where player.id matches", () => {
    const events = [OG_EVENT_MOROCCO_CANADA];
    const result = deriveAllPlayerRawStats(
      events,
      [makeMoroccoPlayers(), makeCanadaPlayers()],
      MOROCCO_TEAM_ID,
      CANADA_TEAM_ID
    );
    // Aguerd (232) scored the OG
    expect(result.get(232)?.ownGoals).toBe(1);
    // Canada players get 0
    expect(result.get(300)?.ownGoals).toBe(0);
  });
});
