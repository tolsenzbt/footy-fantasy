CREATE TYPE "public"."draft_status" AS ENUM('pending', 'active', 'paused', 'complete');--> statement-breakpoint
CREATE TYPE "public"."draft_type" AS ENUM('initial', 'redraft');--> statement-breakpoint
CREATE TYPE "public"."fantasy_position" AS ENUM('GK', 'DEF', 'MID', 'FWD');--> statement-breakpoint
CREATE TYPE "public"."fantasy_round" AS ENUM('group_md1', 'group_md2', 'group_md3', 'qf', 'sf', 'final');--> statement-breakpoint
CREATE TYPE "public"."league_format" AS ENUM('eight', 'twelve', 'sixteen');--> statement-breakpoint
CREATE TYPE "public"."league_status" AS ENUM('setup', 'drafting', 'group_stage', 'redrafting', 'knockouts', 'complete');--> statement-breakpoint
CREATE TYPE "public"."lineup_slot_type" AS ENUM('starter', 'bench');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('admin', 'commissioner', 'manager');--> statement-breakpoint
CREATE TYPE "public"."pick_acquisition_method" AS ENUM('initial_draft', 'redraft', 'waiver', 'free_agent');--> statement-breakpoint
CREATE TYPE "public"."waiver_availability_status" AS ENUM('rostered', 'on_waivers', 'free_agent');--> statement-breakpoint
CREATE TYPE "public"."waiver_claim_status" AS ENUM('pending', 'processed_success', 'processed_failed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."waiver_priority_phase" AS ENUM('group_stage', 'knockouts');--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"is_app_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"display_name" text,
	"eliminated_at_round" "fantasy_round",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_memberships_league_id_user_id_unique" UNIQUE("league_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"format" "league_format" NOT NULL,
	"status" "league_status" DEFAULT 'setup' NOT NULL,
	"locked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fifa_code" text NOT NULL,
	"real_group" text NOT NULL,
	"api_football_id" integer NOT NULL,
	"eliminated_at_round" "fantasy_round",
	"next_fixture_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nations_api_football_id_unique" UNIQUE("api_football_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"nation_id" uuid NOT NULL,
	"real_position" text NOT NULL,
	"fantasy_position" "fantasy_position" NOT NULL,
	"api_football_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_api_football_id_unique" UNIQUE("api_football_id")
);
--> statement-breakpoint
CREATE TABLE "real_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round" "fantasy_round" NOT NULL,
	"home_nation_id" uuid NOT NULL,
	"away_nation_id" uuid NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"api_football_id" integer NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "real_fixtures_api_football_id_unique" UNIQUE("api_football_id")
);
--> statement-breakpoint
CREATE TABLE "player_match_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixture_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"override_points" numeric(6, 2),
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_match_scores_fixture_id_player_id_unique" UNIQUE("fixture_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "player_match_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixture_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"minutes_played" integer DEFAULT 0 NOT NULL,
	"goals" integer DEFAULT 0 NOT NULL,
	"assists" integer DEFAULT 0 NOT NULL,
	"clean_sheet" boolean DEFAULT false NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"penalty_saved" boolean DEFAULT false NOT NULL,
	"penalty_missed" boolean DEFAULT false NOT NULL,
	"goals_conceded" integer DEFAULT 0 NOT NULL,
	"yellow_cards" integer DEFAULT 0 NOT NULL,
	"red_card" boolean DEFAULT false NOT NULL,
	"own_goals" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_match_stats_fixture_id_player_id_unique" UNIQUE("fixture_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "raw_api_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixture_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"response_hash" text NOT NULL,
	CONSTRAINT "raw_api_responses_fixture_id_response_hash_unique" UNIQUE("fixture_id","response_hash")
);
--> statement-breakpoint
CREATE TABLE "fantasy_matchups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"fantasy_round_id" uuid NOT NULL,
	"home_manager_id" uuid,
	"away_manager_id" uuid,
	"home_seed_source" text,
	"away_seed_source" text,
	"home_score" numeric(8, 2),
	"away_score" numeric(8, 2),
	"winner_manager_id" uuid,
	"match_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fantasy_matchups_league_id_fantasy_round_id_match_index_unique" UNIQUE("league_id","fantasy_round_id","match_index")
);
--> statement-breakpoint
CREATE TABLE "fantasy_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"round" "fantasy_round" NOT NULL,
	"opens_at" timestamp with time zone,
	"locks_at" timestamp with time zone,
	"processes_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fantasy_rounds_league_id_round_unique" UNIQUE("league_id","round")
);
--> statement-breakpoint
CREATE TABLE "group_standings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"group_letter" text NOT NULL,
	"rank" integer NOT NULL,
	"manager_id" uuid NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"points_for" numeric(8, 2) DEFAULT '0' NOT NULL,
	"points_against" numeric(8, 2) DEFAULT '0' NOT NULL,
	"highest_single_score" numeric(6, 2) DEFAULT '0' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_standings_league_id_group_letter_rank_unique" UNIQUE("league_id","group_letter","rank"),
	CONSTRAINT "group_standings_league_id_manager_id_unique" UNIQUE("league_id","manager_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"slot_code" text NOT NULL,
	"group_letter" text NOT NULL,
	"position_in_group" integer NOT NULL,
	"manager_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_slots_league_id_slot_code_unique" UNIQUE("league_id","slot_code")
);
--> statement-breakpoint
CREATE TABLE "lineup_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lineup_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"slot_type" "lineup_slot_type" NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineup_slots_lineup_id_player_id_unique" UNIQUE("lineup_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "lineups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"fantasy_round_id" uuid NOT NULL,
	"formation" text NOT NULL,
	"captain_player_id" uuid,
	"vc_player_id" uuid,
	"captain_locked_at" timestamp with time zone,
	"vc_locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineups_league_id_manager_id_fantasy_round_id_unique" UNIQUE("league_id","manager_id","fantasy_round_id")
);
--> statement-breakpoint
CREATE TABLE "rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"acquired_via" "pick_acquisition_method" NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rosters_league_id_player_id_unique" UNIQUE("league_id","player_id"),
	CONSTRAINT "rosters_league_id_manager_id_player_id_unique" UNIQUE("league_id","manager_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "draft_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"manager_id" uuid NOT NULL,
	"has_passed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_order_draft_id_position_unique" UNIQUE("draft_id","position"),
	CONSTRAINT "draft_order_draft_id_manager_id_unique" UNIQUE("draft_id","manager_id")
);
--> statement-breakpoint
CREATE TABLE "draft_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"pick_number" integer NOT NULL,
	"manager_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"dropped_player_id" uuid,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_expired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_picks_draft_id_pick_number_unique" UNIQUE("draft_id","pick_number"),
	CONSTRAINT "draft_picks_draft_id_player_id_unique" UNIQUE("draft_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"type" "draft_type" NOT NULL,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"current_pick_number" integer,
	"pick_clock_seconds" integer NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_league_id_type_unique" UNIQUE("league_id","type")
);
--> statement-breakpoint
CREATE TABLE "waiver_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"drop_player_id" uuid,
	"priority_at_submit" integer NOT NULL,
	"status" "waiver_claim_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_event_id" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiver_player_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"status" "waiver_availability_status" NOT NULL,
	"eligible_at" timestamp with time zone,
	"current_fantasy_round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waiver_player_status_league_id_player_id_unique" UNIQUE("league_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "waiver_priority" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"phase" "waiver_priority_phase" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waiver_priority_league_id_manager_id_phase_unique" UNIQUE("league_id","manager_id","phase"),
	CONSTRAINT "waiver_priority_league_id_priority_phase_unique" UNIQUE("league_id","priority","phase")
);
--> statement-breakpoint
CREATE TABLE "waiver_processing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"fantasy_round_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waiver_processing_events_league_id_fantasy_round_id_unique" UNIQUE("league_id","fantasy_round_id")
);
--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_nation_id_nations_id_fk" FOREIGN KEY ("nation_id") REFERENCES "public"."nations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_fixtures" ADD CONSTRAINT "real_fixtures_home_nation_id_nations_id_fk" FOREIGN KEY ("home_nation_id") REFERENCES "public"."nations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_fixtures" ADD CONSTRAINT "real_fixtures_away_nation_id_nations_id_fk" FOREIGN KEY ("away_nation_id") REFERENCES "public"."nations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_scores" ADD CONSTRAINT "player_match_scores_fixture_id_real_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."real_fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_scores" ADD CONSTRAINT "player_match_scores_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_fixture_id_real_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."real_fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_api_responses" ADD CONSTRAINT "raw_api_responses_fixture_id_real_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."real_fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_fantasy_round_id_fantasy_rounds_id_fk" FOREIGN KEY ("fantasy_round_id") REFERENCES "public"."fantasy_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_home_manager_id_league_memberships_id_fk" FOREIGN KEY ("home_manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_away_manager_id_league_memberships_id_fk" FOREIGN KEY ("away_manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_winner_manager_id_league_memberships_id_fk" FOREIGN KEY ("winner_manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_rounds" ADD CONSTRAINT "fantasy_rounds_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_standings" ADD CONSTRAINT "group_standings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_standings" ADD CONSTRAINT "group_standings_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_slots" ADD CONSTRAINT "lineup_slots_lineup_id_lineups_id_fk" FOREIGN KEY ("lineup_id") REFERENCES "public"."lineups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_slots" ADD CONSTRAINT "lineup_slots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_fantasy_round_id_fantasy_rounds_id_fk" FOREIGN KEY ("fantasy_round_id") REFERENCES "public"."fantasy_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_captain_player_id_players_id_fk" FOREIGN KEY ("captain_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_vc_player_id_players_id_fk" FOREIGN KEY ("vc_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_dropped_player_id_players_id_fk" FOREIGN KEY ("dropped_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_drop_player_id_players_id_fk" FOREIGN KEY ("drop_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_processing_event_id_waiver_processing_events_id_fk" FOREIGN KEY ("processing_event_id") REFERENCES "public"."waiver_processing_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD CONSTRAINT "waiver_player_status_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD CONSTRAINT "waiver_player_status_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_player_status" ADD CONSTRAINT "waiver_player_status_current_fantasy_round_id_fantasy_rounds_id_fk" FOREIGN KEY ("current_fantasy_round_id") REFERENCES "public"."fantasy_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_priority" ADD CONSTRAINT "waiver_priority_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_priority" ADD CONSTRAINT "waiver_priority_manager_id_league_memberships_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."league_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_processing_events" ADD CONSTRAINT "waiver_processing_events_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_processing_events" ADD CONSTRAINT "waiver_processing_events_fantasy_round_id_fantasy_rounds_id_fk" FOREIGN KEY ("fantasy_round_id") REFERENCES "public"."fantasy_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_auth_users_id_fk" 
  FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "waiver_claims_active_claim_unique" 
  ON "waiver_claims" ("league_id", "manager_id", "player_id") 
  WHERE "status" = 'pending';
