ALTER TABLE "drafts" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "current_pick_started_at" timestamp with time zone;