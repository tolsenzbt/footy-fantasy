import { relations } from "drizzle-orm";
import { profiles } from "./auth";
import { leagues, leagueMemberships } from "./league";
import { nations, players, realFixtures } from "./tournament";
import { rawApiResponses, playerMatchStats, playerMatchScores } from "./stats";
import {
  scheduleSlots,
  groupStandings,
  fantasyRounds,
  fantasyMatchups,
} from "./schedule";
import { rosters, lineups, lineupSlots } from "./roster";
import { drafts, draftOrder, draftPicks } from "./draft";
import {
  waiverPlayerStatus,
  waiverProcessingEvents,
  waiverPriority,
  waiverClaims,
} from "./waivers";

export const profilesRelations = relations(profiles, ({ many }) => ({
  leagueMemberships: many(leagueMemberships),
  createdLeagues: many(leagues),
}));

export const leaguesRelations = relations(leagues, ({ one, many }) => ({
  createdBy: one(profiles, {
    fields: [leagues.createdBy],
    references: [profiles.id],
  }),
  memberships: many(leagueMemberships),
  scheduleSlots: many(scheduleSlots),
  groupStandings: many(groupStandings),
  fantasyRounds: many(fantasyRounds),
  fantasyMatchups: many(fantasyMatchups),
  rosters: many(rosters),
  lineups: many(lineups),
  drafts: many(drafts),
  waiverPlayerStatuses: many(waiverPlayerStatus),
  waiverProcessingEvents: many(waiverProcessingEvents),
  waiverPriorities: many(waiverPriority),
  waiverClaims: many(waiverClaims),
}));

export const leagueMembershipsRelations = relations(
  leagueMemberships,
  ({ one, many }) => ({
    league: one(leagues, {
      fields: [leagueMemberships.leagueId],
      references: [leagues.id],
    }),
    profile: one(profiles, {
      fields: [leagueMemberships.userId],
      references: [profiles.id],
    }),
    rosters: many(rosters),
    lineups: many(lineups),
    draftOrders: many(draftOrder),
    draftPicks: many(draftPicks),
    scheduleSlots: many(scheduleSlots),
    groupStandings: many(groupStandings),
    waiverPriorities: many(waiverPriority),
    waiverClaims: many(waiverClaims),
    homeMatchups: many(fantasyMatchups, { relationName: "homeManager" }),
    awayMatchups: many(fantasyMatchups, { relationName: "awayManager" }),
    wonMatchups: many(fantasyMatchups, { relationName: "winnerManager" }),
  })
);

export const nationsRelations = relations(nations, ({ many, one }) => ({
  players: many(players),
  homeFixtures: many(realFixtures, { relationName: "homeNation" }),
  awayFixtures: many(realFixtures, { relationName: "awayNation" }),
  // nextFixture is a soft FK — no FK constraint in schema, managed via app code
  nextFixture: one(realFixtures, {
    fields: [nations.nextFixtureId],
    references: [realFixtures.id],
    relationName: "nextFixture",
  }),
}));

export const playersRelations = relations(players, ({ one, many }) => ({
  nation: one(nations, {
    fields: [players.nationId],
    references: [nations.id],
  }),
  playerMatchStats: many(playerMatchStats),
  playerMatchScores: many(playerMatchScores),
  rosters: many(rosters),
}));

export const realFixturesRelations = relations(
  realFixtures,
  ({ one, many }) => ({
    homeNation: one(nations, {
      fields: [realFixtures.homeNationId],
      references: [nations.id],
      relationName: "homeNation",
    }),
    awayNation: one(nations, {
      fields: [realFixtures.awayNationId],
      references: [nations.id],
      relationName: "awayNation",
    }),
    playerMatchStats: many(playerMatchStats),
    playerMatchScores: many(playerMatchScores),
    rawApiResponses: many(rawApiResponses),
    nationsWithThisAsNext: many(nations, { relationName: "nextFixture" }),
  })
);

export const rawApiResponsesRelations = relations(
  rawApiResponses,
  ({ one }) => ({
    fixture: one(realFixtures, {
      fields: [rawApiResponses.fixtureId],
      references: [realFixtures.id],
    }),
  })
);

export const playerMatchStatsRelations = relations(
  playerMatchStats,
  ({ one }) => ({
    fixture: one(realFixtures, {
      fields: [playerMatchStats.fixtureId],
      references: [realFixtures.id],
    }),
    player: one(players, {
      fields: [playerMatchStats.playerId],
      references: [players.id],
    }),
  })
);

export const playerMatchScoresRelations = relations(
  playerMatchScores,
  ({ one }) => ({
    fixture: one(realFixtures, {
      fields: [playerMatchScores.fixtureId],
      references: [realFixtures.id],
    }),
    player: one(players, {
      fields: [playerMatchScores.playerId],
      references: [players.id],
    }),
  })
);

export const scheduleSlotsRelations = relations(scheduleSlots, ({ one }) => ({
  league: one(leagues, {
    fields: [scheduleSlots.leagueId],
    references: [leagues.id],
  }),
  manager: one(leagueMemberships, {
    fields: [scheduleSlots.managerId],
    references: [leagueMemberships.id],
  }),
}));

export const groupStandingsRelations = relations(
  groupStandings,
  ({ one }) => ({
    league: one(leagues, {
      fields: [groupStandings.leagueId],
      references: [leagues.id],
    }),
    manager: one(leagueMemberships, {
      fields: [groupStandings.managerId],
      references: [leagueMemberships.id],
    }),
  })
);

export const fantasyRoundsRelations = relations(
  fantasyRounds,
  ({ one, many }) => ({
    league: one(leagues, {
      fields: [fantasyRounds.leagueId],
      references: [leagues.id],
    }),
    matchups: many(fantasyMatchups),
    lineups: many(lineups),
    waiverProcessingEvents: many(waiverProcessingEvents),
    waiverPlayerStatuses: many(waiverPlayerStatus),
  })
);

export const fantasyMatchupsRelations = relations(
  fantasyMatchups,
  ({ one }) => ({
    league: one(leagues, {
      fields: [fantasyMatchups.leagueId],
      references: [leagues.id],
    }),
    fantasyRound: one(fantasyRounds, {
      fields: [fantasyMatchups.fantasyRoundId],
      references: [fantasyRounds.id],
    }),
    homeManager: one(leagueMemberships, {
      fields: [fantasyMatchups.homeManagerId],
      references: [leagueMemberships.id],
      relationName: "homeManager",
    }),
    awayManager: one(leagueMemberships, {
      fields: [fantasyMatchups.awayManagerId],
      references: [leagueMemberships.id],
      relationName: "awayManager",
    }),
    winnerManager: one(leagueMemberships, {
      fields: [fantasyMatchups.winnerManagerId],
      references: [leagueMemberships.id],
      relationName: "winnerManager",
    }),
  })
);

export const rostersRelations = relations(rosters, ({ one }) => ({
  league: one(leagues, {
    fields: [rosters.leagueId],
    references: [leagues.id],
  }),
  manager: one(leagueMemberships, {
    fields: [rosters.managerId],
    references: [leagueMemberships.id],
  }),
  player: one(players, {
    fields: [rosters.playerId],
    references: [players.id],
  }),
}));

export const lineupsRelations = relations(lineups, ({ one, many }) => ({
  league: one(leagues, {
    fields: [lineups.leagueId],
    references: [leagues.id],
  }),
  manager: one(leagueMemberships, {
    fields: [lineups.managerId],
    references: [leagueMemberships.id],
  }),
  fantasyRound: one(fantasyRounds, {
    fields: [lineups.fantasyRoundId],
    references: [fantasyRounds.id],
  }),
  captain: one(players, {
    fields: [lineups.captainPlayerId],
    references: [players.id],
    relationName: "captain",
  }),
  vc: one(players, {
    fields: [lineups.vcPlayerId],
    references: [players.id],
    relationName: "vc",
  }),
  slots: many(lineupSlots),
}));

export const lineupSlotsRelations = relations(lineupSlots, ({ one }) => ({
  lineup: one(lineups, {
    fields: [lineupSlots.lineupId],
    references: [lineups.id],
  }),
  player: one(players, {
    fields: [lineupSlots.playerId],
    references: [players.id],
  }),
}));

export const draftsRelations = relations(drafts, ({ one, many }) => ({
  league: one(leagues, {
    fields: [drafts.leagueId],
    references: [leagues.id],
  }),
  draftOrder: many(draftOrder),
  draftPicks: many(draftPicks),
}));

export const draftOrderRelations = relations(draftOrder, ({ one }) => ({
  draft: one(drafts, {
    fields: [draftOrder.draftId],
    references: [drafts.id],
  }),
  manager: one(leagueMemberships, {
    fields: [draftOrder.managerId],
    references: [leagueMemberships.id],
  }),
}));

export const draftPicksRelations = relations(draftPicks, ({ one }) => ({
  draft: one(drafts, {
    fields: [draftPicks.draftId],
    references: [drafts.id],
  }),
  manager: one(leagueMemberships, {
    fields: [draftPicks.managerId],
    references: [leagueMemberships.id],
  }),
  player: one(players, {
    fields: [draftPicks.playerId],
    references: [players.id],
  }),
  droppedPlayer: one(players, {
    fields: [draftPicks.droppedPlayerId],
    references: [players.id],
    relationName: "droppedPlayer",
  }),
}));

export const waiverPlayerStatusRelations = relations(
  waiverPlayerStatus,
  ({ one }) => ({
    league: one(leagues, {
      fields: [waiverPlayerStatus.leagueId],
      references: [leagues.id],
    }),
    player: one(players, {
      fields: [waiverPlayerStatus.playerId],
      references: [players.id],
    }),
    currentFantasyRound: one(fantasyRounds, {
      fields: [waiverPlayerStatus.currentFantasyRoundId],
      references: [fantasyRounds.id],
    }),
  })
);

export const waiverProcessingEventsRelations = relations(
  waiverProcessingEvents,
  ({ one, many }) => ({
    league: one(leagues, {
      fields: [waiverProcessingEvents.leagueId],
      references: [leagues.id],
    }),
    fantasyRound: one(fantasyRounds, {
      fields: [waiverProcessingEvents.fantasyRoundId],
      references: [fantasyRounds.id],
    }),
    claims: many(waiverClaims),
  })
);

export const waiverPriorityRelations = relations(waiverPriority, ({ one }) => ({
  league: one(leagues, {
    fields: [waiverPriority.leagueId],
    references: [leagues.id],
  }),
  manager: one(leagueMemberships, {
    fields: [waiverPriority.managerId],
    references: [leagueMemberships.id],
  }),
}));

export const waiverClaimsRelations = relations(waiverClaims, ({ one }) => ({
  league: one(leagues, {
    fields: [waiverClaims.leagueId],
    references: [leagues.id],
  }),
  manager: one(leagueMemberships, {
    fields: [waiverClaims.managerId],
    references: [leagueMemberships.id],
  }),
  player: one(players, {
    fields: [waiverClaims.playerId],
    references: [players.id],
  }),
  dropPlayer: one(players, {
    fields: [waiverClaims.dropPlayerId],
    references: [players.id],
    relationName: "dropPlayer",
  }),
  processingEvent: one(waiverProcessingEvents, {
    fields: [waiverClaims.processingEventId],
    references: [waiverProcessingEvents.id],
  }),
}));
