import {
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { leagueMemberships, leagues } from "./league";
import { fantasyRound } from "./enums";

export const scheduleSlots = pgTable(
  "schedule_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    slotCode: text("slot_code").notNull(),
    groupLetter: text("group_letter").notNull(),
    positionInGroup: integer("position_in_group").notNull(),
    // Nullable until group draw assigns a manager
    managerId: uuid("manager_id").references(() => leagueMemberships.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.leagueId, t.slotCode),
    // Partial unique on (league_id, manager_id) where manager_id is not null.
    // Drizzle doesn't support partial unique indexes declaratively; enforced in app code.
    // A standard unique here would prevent multiple null manager_ids, so we omit it.
  ]
);

export const groupStandings = pgTable(
  "group_standings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    groupLetter: text("group_letter").notNull(),
    rank: integer("rank").notNull(),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    pointsFor: numeric("points_for", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    pointsAgainst: numeric("points_against", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    highestSingleScore: numeric("highest_single_score", {
      precision: 6,
      scale: 2,
    })
      .notNull()
      .default("0"),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.leagueId, t.groupLetter, t.rank),
    unique().on(t.leagueId, t.managerId),
  ]
);

export const fantasyRounds = pgTable(
  "fantasy_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    round: fantasyRound("round").notNull(),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    locksAt: timestamp("locks_at", { withTimezone: true }),
    processesAt: timestamp("processes_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.round)]
);

export const fantasyMatchups = pgTable(
  "fantasy_matchups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    fantasyRoundId: uuid("fantasy_round_id")
      .notNull()
      .references(() => fantasyRounds.id),
    homeManagerId: uuid("home_manager_id").references(
      () => leagueMemberships.id
    ),
    awayManagerId: uuid("away_manager_id").references(
      () => leagueMemberships.id
    ),
    // Seed source text for knockout bracket skeleton, e.g. '1A', 'winner_of_qf_match_3'
    homeSeedSource: text("home_seed_source"),
    awaySeedSource: text("away_seed_source"),
    homeScore: numeric("home_score", { precision: 8, scale: 2 }),
    awayScore: numeric("away_score", { precision: 8, scale: 2 }),
    winnerManagerId: uuid("winner_manager_id").references(
      () => leagueMemberships.id
    ),
    matchIndex: integer("match_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.fantasyRoundId, t.matchIndex)]
);
