CREATE TABLE "player_projections" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"minutes" numeric,
	"goals" numeric,
	"assists" numeric,
	"shots" numeric,
	"shots_on_goal" numeric,
	"chances_created" numeric,
	"passes" numeric,
	"crosses" numeric,
	"accurate_crosses" numeric,
	"interceptions" numeric,
	"tackles" numeric,
	"tackles_won" numeric,
	"blocks" numeric,
	"clearances" numeric,
	"clean_sheets" numeric,
	"goals_conceded" numeric,
	"saves" numeric,
	"fouls_suffered" numeric,
	"fouls_committed" numeric,
	"yellow_cards" numeric,
	"red_cards" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_rankings" ADD COLUMN "projected_points" numeric;--> statement-breakpoint
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;