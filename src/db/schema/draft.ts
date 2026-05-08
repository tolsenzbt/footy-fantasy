import {
  boolean,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { leagueMemberships, leagues } from "./league";
import { players } from "./tournament";
import { draftStatus, draftType } from "./enums";

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    type: draftType("type").notNull(),
    status: draftStatus("status").notNull().default("pending"),
    currentPickNumber: integer("current_pick_number"),
    pickClockSeconds: integer("pick_clock_seconds").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    currentPickStartedAt: timestamp("current_pick_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.type)]
);

export const draftOrder = pgTable(
  "draft_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    hasPassed: boolean("has_passed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.draftId, t.position),
    unique().on(t.draftId, t.managerId),
  ]
);

export const draftPicks = pgTable(
  "draft_picks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    pickNumber: integer("pick_number").notNull(),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    droppedPlayerId: uuid("dropped_player_id").references(() => players.id),
    pickedAt: timestamp("picked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    clockExpired: boolean("clock_expired").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.draftId, t.pickNumber),
    unique().on(t.draftId, t.playerId),
  ]
);
