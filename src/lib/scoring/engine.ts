export type FantasyPosition = "GK" | "DEF" | "MID" | "FWD";

export type PlayerMatchStats = {
  minutesPlayed: number;
  goals: number;
  assists: number;
  concededWhileOnPitch: number;
  saves: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
};

const GOAL_PTS: Record<FantasyPosition, number>         = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
const CLEAN_SHEET_PTS: Record<FantasyPosition, number>  = { GK: 4,  DEF: 4, MID: 1, FWD: 0 };

export function scorePlayer(stats: PlayerMatchStats, position: FantasyPosition): number {
  let pts = 0;

  // Appearance: 0 min = 0 pts, 1–59 = 1 pt, 60+ = 2 pts
  if (stats.minutesPlayed >= 60) {
    pts += 2;
  } else if (stats.minutesPlayed >= 1) {
    pts += 1;
  }

  // Goals scored (position-dependent)
  pts += stats.goals * GOAL_PTS[position];

  // Assists (all positions)
  pts += stats.assists * 3;

  // Clean sheet: 60+ min AND 0 conceded while on pitch AND no red card
  if (stats.minutesPlayed >= 60 && stats.concededWhileOnPitch === 0 && stats.redCards === 0) {
    pts += CLEAN_SHEET_PTS[position];
  }

  // Saves bonus and penalty saved: GK only
  if (position === "GK") {
    pts += Math.floor(stats.saves / 3);
    pts += stats.penaltiesSaved * 5;
  }

  // Goals conceded penalty: GK and DEF only (-1 per 2 conceded)
  if (position === "GK" || position === "DEF") {
    pts -= Math.floor(stats.concededWhileOnPitch / 2);
  }

  // Penalty missed (all positions)
  pts += stats.penaltiesMissed * -2;

  // Cards (all positions; red card voids clean sheet but not appearance — handled above)
  pts += stats.yellowCards * -1;
  pts += stats.redCards * -3;

  // Own goals (all positions)
  pts += stats.ownGoals * -2;

  return pts;
}

export function applyCaptainMultiplier(basePoints: number, isCaptain: boolean): number {
  return isCaptain ? basePoints * 2 : basePoints;
}
