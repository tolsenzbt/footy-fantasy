ALTER TABLE "players" DROP COLUMN "real_position";--> statement-breakpoint
ALTER TABLE "players" RENAME COLUMN "fantasy_position" TO "position";--> statement-breakpoint
CREATE TYPE "public"."play_status" AS ENUM('definite_starter', 'probable_starter', 'possible_starter', 'probable_substitute', 'possible_substitute', 'wont_play_much');--> statement-breakpoint
CREATE TABLE "player_rankings" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"o_rank" integer,
	"play_status" "play_status",
	"o_rank_overridden" boolean DEFAULT false NOT NULL,
	"status_overridden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_rankings" ADD CONSTRAINT "player_rankings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
