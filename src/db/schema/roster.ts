import {
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { leagueMemberships, leagues } from "./league";
import { players } from "./tournament";
import { fantasyRounds } from "./schedule";
import { lineupSlotType, pickAcquisitionMethod } from "./enums";

export const rosters = pgTable(
  "rosters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    acquiredVia: pickAcquisitionMethod("acquired_via").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.leagueId, t.playerId),
    unique().on(t.leagueId, t.managerId, t.playerId),
  ]
);

export const lineups = pgTable(
  "lineups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    fantasyRoundId: uuid("fantasy_round_id")
      .notNull()
      .references(() => fantasyRounds.id),
    formation: text("formation").notNull(),
    captainPlayerId: uuid("captain_player_id").references(() => players.id),
    vcPlayerId: uuid("vc_player_id").references(() => players.id),
    captainLockedAt: timestamp("captain_locked_at", { withTimezone: true }),
    vcLockedAt: timestamp("vc_locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.managerId, t.fantasyRoundId)]
);

export const lineupSlots = pgTable(
  "lineup_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lineupId: uuid("lineup_id")
      .notNull()
      .references(() => lineups.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    slotType: lineupSlotType("slot_type").notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.lineupId, t.playerId)]
);
