import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./auth";
import { fantasyRound, leagueFormat, leagueStatus, membershipRole } from "./enums";

export const leagues = pgTable("leagues", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  format: leagueFormat("format").notNull(),
  status: leagueStatus("status").notNull().default("setup"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  massReleaseCompletedAt: timestamp("mass_release_completed_at", { withTimezone: true }),
  redraftPoolFrozenAt: timestamp("redraft_pool_frozen_at", { withTimezone: true }),
  priorityResetCompletedAt: timestamp("priority_reset_completed_at", { withTimezone: true }),
  knockoutFirstEventScheduledAt: timestamp("knockout_first_event_scheduled_at", { withTimezone: true }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const leagueMemberships = pgTable(
  "league_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id),
    role: membershipRole("role").notNull(),
    displayName: text("display_name"),
    eliminatedAtRound: fantasyRound("eliminated_at_round"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.leagueId, t.userId)]
);
