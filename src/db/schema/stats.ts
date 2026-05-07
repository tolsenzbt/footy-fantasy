import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { players, realFixtures } from "./tournament";

export const rawApiResponses = pgTable(
  "raw_api_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fixtureId: uuid("fixture_id")
      .notNull()
      .references(() => realFixtures.id),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull(),
    responseHash: text("response_hash").notNull(),
  },
  (t) => [unique().on(t.fixtureId, t.responseHash)]
);

export const playerMatchStats = pgTable(
  "player_match_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fixtureId: uuid("fixture_id")
      .notNull()
      .references(() => realFixtures.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    minutesPlayed: integer("minutes_played").notNull().default(0),
    goals: integer("goals").notNull().default(0),
    assists: integer("assists").notNull().default(0),
    cleanSheet: boolean("clean_sheet").notNull().default(false),
    saves: integer("saves").notNull().default(0),
    penaltySaved: boolean("penalty_saved").notNull().default(false),
    penaltyMissed: boolean("penalty_missed").notNull().default(false),
    goalsConceded: integer("goals_conceded").notNull().default(0),
    yellowCards: integer("yellow_cards").notNull().default(0),
    redCard: boolean("red_card").notNull().default(false),
    ownGoals: integer("own_goals").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.fixtureId, t.playerId)]
);

export const playerMatchScores = pgTable(
  "player_match_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fixtureId: uuid("fixture_id")
      .notNull()
      .references(() => realFixtures.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    points: numeric("points", { precision: 6, scale: 2 }).notNull(),
    overridePoints: numeric("override_points", { precision: 6, scale: 2 }),
    overrideReason: text("override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.fixtureId, t.playerId)]
);
