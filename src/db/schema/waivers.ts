import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { leagueMemberships, leagues } from "./league";
import { players } from "./tournament";
import { fantasyRounds } from "./schedule";
import { waiverAvailabilityStatus, waiverClaimStatus, waiverPriorityPhase } from "./enums";

export const waiverPlayerStatus = pgTable(
  "waiver_player_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    status: waiverAvailabilityStatus("status").notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    currentFantasyRoundId: uuid("current_fantasy_round_id").references(
      () => fantasyRounds.id
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.playerId)]
);

export const waiverProcessingEvents = pgTable(
  "waiver_processing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    fantasyRoundId: uuid("fantasy_round_id")
      .notNull()
      .references(() => fantasyRounds.id),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.fantasyRoundId)]
);

export const waiverPriority = pgTable(
  "waiver_priority",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => leagueMemberships.id),
    priority: integer("priority").notNull(),
    phase: waiverPriorityPhase("phase").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.leagueId, t.managerId, t.phase),
    unique().on(t.leagueId, t.priority, t.phase),
  ]
);

// NOTE: waiver_claims has a partial unique index added in the migration SQL:
//   CREATE UNIQUE INDEX "waiver_claims_active_claim_unique"
//     ON "waiver_claims" ("league_id", "manager_id", "player_id")
//     WHERE "status" = 'pending';
// Drizzle can't declare partial unique indexes. If the migration is ever
// regenerated, re-add this index manually.
export const waiverClaims = pgTable("waiver_claims", {
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
  dropPlayerId: uuid("drop_player_id").references(() => players.id),
  priorityAtSubmit: integer("priority_at_submit").notNull(),
  status: waiverClaimStatus("status").notNull().default("pending"),
  submittedAt: timestamp("submitted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingEventId: uuid("processing_event_id").references(
    () => waiverProcessingEvents.id
  ),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
