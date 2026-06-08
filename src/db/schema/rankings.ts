import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { playStatus } from "./enums";
import { players } from "./tournament";

export const playerRankings = pgTable("player_rankings", {
  playerId: uuid("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  oRank: integer("o_rank"),
  playStatus: playStatus("play_status"),
  oRankOverridden: boolean("o_rank_overridden").notNull().default(false),
  statusOverridden: boolean("status_overridden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
