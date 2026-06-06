export type ApiEventTime = { elapsed: number; extra: number | null };

export type ApiEvent = {
  time: ApiEventTime;
  team: { id: number; name: string };
  player: { id: number; name: string };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string;
  comments: string | null;
};

export type ApiPlayerGames = {
  minutes: number | null;
  number: number;
  position: string;
  rating: string | null;
  captain: boolean;
  substitute: boolean;
};

export type ApiPlayerStatistics = {
  games: ApiPlayerGames;
  goals: {
    total: number | null;
    conceded: number | null;
    assists: number | null;
    saves: number | null;
  };
  // API-Football returns null for cards/penalty fields when the player had none.
  // The type claims number but the runtime reality is number | null.
  cards: { yellow: number | null; red: number | null };
  penalty: {
    won: number | null;
    commited: number | null;
    scored: number | null;
    missed: number | null;
    saved: number | null;
  };
};

export type ApiPlayerEntry = {
  player: { id: number; name: string; photo?: string };
  statistics: [ApiPlayerStatistics];
};

export type ApiTeamPlayersEntry = {
  team: { id: number; name: string };
  players: ApiPlayerEntry[];
};

export type RawPlayerStats = {
  minutesPlayed: number;
  goals: number;
  assists: number;
  saves: number;
  penaltySaves: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCard: boolean;
  ownGoals: number;
  goalsConceded: number;
  cleanSheet: boolean;
  concededWhileOnPitch: number;
  position: string;
};

// Minutes threshold beyond which a duration mismatch is logged as a warning.
const MINUTES_SLACK = 3;

export function goalMinute(event: ApiEvent): number {
  return event.time.elapsed + (event.time.extra ?? 0);
}

// Returns per-player on-pitch intervals for one team's players.
// onMin = 0 for starters, sub-on minute for substitutes (Infinity until found).
// offMin = sub-off minute or red-card minute, Infinity if they played to the whistle.
function buildOnPitchIntervals(
  events: ApiEvent[],
  players: ApiTeamPlayersEntry[],
  teamId: number,
): Map<number, { onMin: number; offMin: number }> {
  const teamEntry = players.find((t) => t.team.id === teamId);
  if (!teamEntry) return new Map();

  const intervals = new Map<number, { onMin: number; offMin: number }>();
  for (const p of teamEntry.players) {
    const isSubstitute = p.statistics[0].games.substitute;
    intervals.set(p.player.id, { onMin: isSubstitute ? Infinity : 0, offMin: Infinity });
  }

  for (const event of events) {
    if (event.team.id !== teamId) continue;

    if (event.type === "subst") {
      const minute = goalMinute(event);
      const comingOffId = event.player.id;
      const comingOnId = event.assist.id;

      const offEntry = intervals.get(comingOffId);
      if (offEntry) offEntry.offMin = Math.min(offEntry.offMin, minute);

      if (comingOnId !== null) {
        const onEntry = intervals.get(comingOnId);
        if (onEntry) onEntry.onMin = minute;
      }
    } else if (event.type === "Card" && event.detail === "Red Card") {
      const minute = goalMinute(event);
      const entry = intervals.get(event.player.id);
      if (entry) entry.offMin = Math.min(entry.offMin, minute);
    }
  }

  return intervals;
}

export function deriveConcededWhileOnPitch(
  events: ApiEvent[],
  players: ApiTeamPlayersEntry[],
  homeTeamId: number,
  awayTeamId: number,
): Map<number, number> {
  const homeIntervals = buildOnPitchIntervals(events, players, homeTeamId);
  const awayIntervals = buildOnPitchIntervals(events, players, awayTeamId);

  const goalEvents = events.filter((e) => e.type === "Goal");

  const result = new Map<number, number>();

  for (const [intervals, teamId] of [
    [homeIntervals, homeTeamId],
    [awayIntervals, awayTeamId],
  ] as const) {
    for (const [playerId, { onMin, offMin }] of intervals) {
      if (onMin === Infinity) {
        result.set(playerId, 0);
        continue;
      }

      let conceded = 0;
      for (const goal of goalEvents) {
        // Conceding team = team that is NOT goal.team.id (uniform; OG beneficiary is team.id)
        if (goal.team.id === teamId) continue;
        const G = goalMinute(goal);
        if (onMin <= G && G < offMin) conceded++;
      }
      result.set(playerId, conceded);
    }
  }

  // Validation guard: cross-check derived on-pitch duration against API games.minutes
  for (const teamEntry of players) {
    for (const p of teamEntry.players) {
      const apiMinutes = p.statistics[0].games.minutes ?? 0;
      const isHome = teamEntry.team.id === homeTeamId;
      const intervals = isHome ? homeIntervals : awayIntervals;
      const entry = intervals.get(p.player.id);
      if (!entry || entry.onMin === Infinity) continue;

      let derivedMinutes: number;
      if (entry.onMin === 0 && entry.offMin === Infinity) {
        derivedMinutes = apiMinutes; // starter played to whistle — trust API
      } else if (entry.onMin === 0 && entry.offMin < Infinity) {
        derivedMinutes = entry.offMin;
      } else if (entry.onMin > 0 && entry.offMin === Infinity) {
        derivedMinutes = apiMinutes; // sub played to whistle — trust API
      } else {
        derivedMinutes = entry.offMin - entry.onMin;
      }

      if (Math.abs(derivedMinutes - apiMinutes) > MINUTES_SLACK) {
        console.warn(
          `conceded derivation: minutes discrepancy for player ${p.player.id} — derived ${derivedMinutes}, API ${apiMinutes}`,
        );
      }
    }
  }

  return result;
}

export function deriveAllPlayerRawStats(
  events: ApiEvent[],
  players: ApiTeamPlayersEntry[],
  homeTeamId: number,
  awayTeamId: number,
): Map<number, RawPlayerStats> {
  const concededMap = deriveConcededWhileOnPitch(events, players, homeTeamId, awayTeamId);

  // Index own-goal scorers from events (by player.id)
  const ownGoalCounts = new Map<number, number>();
  for (const event of events) {
    if (event.type === "Goal" && event.detail === "Own Goal") {
      ownGoalCounts.set(event.player.id, (ownGoalCounts.get(event.player.id) ?? 0) + 1);
    }
  }

  const result = new Map<number, RawPlayerStats>();

  for (const teamEntry of players) {
    for (const p of teamEntry.players) {
      const s = p.statistics[0];
      const apiMinutes = s.games.minutes ?? 0;
      const apiConceded = s.goals.conceded ?? 0;

      result.set(p.player.id, {
        minutesPlayed: apiMinutes,
        goals: s.goals.total ?? 0,
        assists: s.goals.assists ?? 0,
        saves: s.goals.saves ?? 0,
        penaltySaves: s.penalty.saved ?? 0,
        penaltiesMissed: s.penalty.missed ?? 0,
        yellowCards: s.cards.yellow ?? 0,
        // redCard comes from the per-player API stat (/fixtures/players), while
        // concededWhileOnPitch is derived from event intervals (/fixtures/events).
        // Mid-match these two sources can lag relative to each other: a red card
        // in the player stat may appear before the corresponding Red Card event lands,
        // which would void the clean sheet via redCards without yet truncating the
        // conceded interval. This self-heals once events catch up and is acceptable
        // for live provisional scoring; at full time both sources are settled.
        redCard: (s.cards.red ?? 0) > 0,
        ownGoals: ownGoalCounts.get(p.player.id) ?? 0,
        goalsConceded: apiConceded,
        // cleanSheet raw: API-reported signal — goals.conceded===0 + 60+ minutes
        // Independent of our derived concededWhileOnPitch, per §6 storage model.
        cleanSheet: apiMinutes >= 60 && apiConceded === 0,
        concededWhileOnPitch: concededMap.get(p.player.id) ?? 0,
        position: s.games.position,
      });
    }
  }

  return result;
}
