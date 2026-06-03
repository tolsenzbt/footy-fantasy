ALTER TABLE "real_fixtures" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD COLUMN "penalty_saves" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD COLUMN "penalties_missed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD COLUMN "conceded_while_on_pitch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fantasy_rounds" ADD COLUMN "stats_ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_match_stats" DROP COLUMN "penalty_saved";--> statement-breakpoint
ALTER TABLE "player_match_stats" DROP COLUMN "penalty_missed";