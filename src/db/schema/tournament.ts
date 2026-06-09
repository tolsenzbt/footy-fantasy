import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { fantasyPosition, fantasyRound } from "./enums";

export const nations = pgTable("nations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  fifaCode: text("fifa_code").notNull(),
  isoCode: text("iso_code"),
  realGroup: text("real_group").notNull(),
  apiFootballId: integer("api_football_id").notNull().unique(),
  eliminatedAtRound: fantasyRound("eliminated_at_round"),
  // Soft FK to real_fixtures — not enforced to avoid circular reference
  nextFixtureId: uuid("next_fixture_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  nationId: uuid("nation_id")
    .notNull()
    .references(() => nations.id),
  position: fantasyPosition("position").notNull(),
  apiFootballId: integer("api_football_id").unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const realFixtures = pgTable("real_fixtures", {
  id: uuid("id").primaryKey().defaultRandom(),
  round: fantasyRound("round").notNull(),
  homeNationId: uuid("home_nation_id")
    .notNull()
    .references(() => nations.id),
  awayNationId: uuid("away_nation_id")
    .notNull()
    .references(() => nations.id),
  kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("scheduled"),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  apiFootballId: integer("api_football_id").notNull().unique(),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
