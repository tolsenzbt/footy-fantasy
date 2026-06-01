-- New enum: why a player entered waivers (null = rostered/free_agent/legacy)
CREATE TYPE "public"."drop_reason_type" AS ENUM('mass_release', 'manager_drop');--> statement-breakpoint

-- waiver_player_status: drop reason + who dropped (for mass-release by-need count and frozen-pool filter)
ALTER TABLE "waiver_player_status" ADD COLUMN "drop_reason" "drop_reason_type";--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD COLUMN "dropped_by_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD CONSTRAINT "waiver_player_status_dropped_by_manager_id_fkey" FOREIGN KEY ("dropped_by_manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- drafts: explicit server-authoritative pick deadline (replaces computed expires_at for redraft)
ALTER TABLE "drafts" ADD COLUMN "current_pick_deadline" timestamp with time zone;--> statement-breakpoint

-- draft_order: permanent opt-out flag for redraft (false for all initial-draft rows)
ALTER TABLE "draft_order" ADD COLUMN "opted_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- leagues: idempotency guards for group_stage→knockout transition sequence (§8)
ALTER TABLE "leagues" ADD COLUMN "mass_release_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "redraft_pool_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "priority_reset_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "knockout_first_event_scheduled_at" timestamp with time zone;
