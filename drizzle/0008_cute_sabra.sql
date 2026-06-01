CREATE TYPE "public"."drop_reason_type" AS ENUM('mass_release', 'manager_drop');--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "mass_release_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "redraft_pool_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "priority_reset_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "knockout_first_event_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_standings" ADD COLUMN "random_tiebreak" integer;--> statement-breakpoint
ALTER TABLE "draft_order" ADD COLUMN "opted_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "current_pick_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD COLUMN "drop_reason" "drop_reason_type";--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD COLUMN "dropped_by_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD CONSTRAINT "waiver_player_status_dropped_by_manager_id_league_memberships_id_fk" FOREIGN KEY ("dropped_by_manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE set null ON UPDATE no action;