import { pgEnum } from "drizzle-orm/pg-core";

export const leagueFormat = pgEnum("league_format", [
  "eight",
  "twelve",
  "sixteen",
]);

export const leagueStatus = pgEnum("league_status", [
  "setup",
  "drafting",
  "group_stage",
  "redrafting",
  "knockouts",
  "complete",
]);

export const membershipRole = pgEnum("membership_role", [
  "commissioner",
  "manager",
]);

export const fantasyRound = pgEnum("fantasy_round", [
  "group_md1",
  "group_md2",
  "group_md3",
  "qf",
  "sf",
  "final",
]);

export const fantasyPosition = pgEnum("fantasy_position", [
  "GK",
  "DEF",
  "MID",
  "FWD",
]);

export const lineupSlotType = pgEnum("lineup_slot_type", [
  "starter",
  "bench",
]);

export const draftType = pgEnum("draft_type", ["initial", "redraft"]);

export const draftStatus = pgEnum("draft_status", [
  "pending",
  "active",
  "paused",
  "complete",
]);

export const waiverAvailabilityStatus = pgEnum("waiver_availability_status", [
  "rostered",
  "on_waivers",
  "free_agent",
]);

export const waiverClaimStatus = pgEnum("waiver_claim_status", [
  "pending",
  "processed_success",
  "processed_failed",
  "voided",
]);

export const pickAcquisitionMethod = pgEnum("pick_acquisition_method", [
  "initial_draft",
  "redraft",
  "waiver",
  "free_agent",
]);

export const waiverPriorityPhase = pgEnum("waiver_priority_phase", [
  "group_stage",
  "knockouts",
]);

export const dropReasonType = pgEnum("drop_reason_type", [
  "mass_release",
  "manager_drop",
]);

export const playStatus = pgEnum("play_status", [
  "definite_starter",
  "probable_starter",
  "possible_starter",
  "probable_substitute",
  "possible_substitute",
  "wont_play_much",
]);
