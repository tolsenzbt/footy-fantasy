import { boolean, integer, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { playStatus } from "./enums";
import { players } from "./tournament";

export const playerRankings = pgTable("player_rankings", {
  playerId: uuid("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  oRank: integer("o_rank"),
  projectedPoints: numeric("projected_points"),
  playStatus: playStatus("play_status"),
  oRankOverridden: boolean("o_rank_overridden").notNull().default(false),
  statusOverridden: boolean("status_overridden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playerProjections = pgTable("player_projections", {
  playerId: uuid("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  minutes: numeric("minutes"),
  goals: numeric("goals"),
  assists: numeric("assists"),
  shots: numeric("shots"),
  shotsOnGoal: numeric("shots_on_goal"),
  chancesCreated: numeric("chances_created"),
  passes: numeric("passes"),
  crosses: numeric("crosses"),
  accurateCrosses: numeric("accurate_crosses"),
  interceptions: numeric("interceptions"),
  tackles: numeric("tackles"),
  tacklesWon: numeric("tackles_won"),
  blocks: numeric("blocks"),
  clearances: numeric("clearances"),
  cleanSheets: numeric("clean_sheets"),
  goalsConceded: numeric("goals_conceded"),
  saves: numeric("saves"),
  foulsSuffered: numeric("fouls_suffered"),
  foulsCommitted: numeric("fouls_committed"),
  yellowCards: numeric("yellow_cards"),
  redCards: numeric("red_cards"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
