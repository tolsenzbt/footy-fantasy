import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// NOTE: profiles.id has a manual FK to auth.users(id) added in the migration SQL.
// Drizzle can't express cross-schema FKs declaratively. If the migration is ever
// regenerated, re-add the constraint manually.
export const profiles = pgTable("profiles", {
  // References auth.users(id) — Supabase-managed, not defined in Drizzle
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  isAppAdmin: boolean("is_app_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
