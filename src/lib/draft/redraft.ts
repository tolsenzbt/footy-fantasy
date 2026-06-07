import "server-only";
import { db } from "@/db";
import {
  drafts,
  draftOrder,
  draftPicks,
  leagues,
  leagueMemberships,
  rosters,
  waiverPlayerStatus,
  groupStandings,
  players,
  playerMatchScores,
  realFixtures,
} from "@/db/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { applyOwnershipTransition } from "@/lib/waivers/ownership";
import { resolveDraftPosition } from "./snake";
import type { InferSelectModel } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────────

const REDRAFT_ROUNDS = 10;
const REDRAFT_PICK_CLOCK_SECONDS = 60;

const POSITION_MAX: Record<string, number> = {
  GK: 2,
  DEF: 5,
  MID: 5,
  FWD: 3,
};

// ── Types ──────────────────────────────────────────────────────────────────────

export type ByNeedEntry = {
  managerId: string;
  autoDroppedCount: number;
  groupStagePoints: number;
  highestSingleScore: number;
};

export type DraftOrderEntry = {
  id: string;
  managerId: string;
  position: number;
  optedOut: boolean;
};

export type RedraftState = {
  draft: InferSelectModel<typeof drafts>;
  isExpired: boolean;
  expiresAt: Date | null;
  onTheClockManagerId: string | null;
  isComplete: boolean;
};

// ── Pure helpers ───────────────────────────────────────────────────────────────

// Walk the snake for up to REDRAFT_ROUNDS * N global slots (where N is total
// participants including opted-out), skipping opted-out entries.
// Returns the managerId for the currentPickNumber-th active pick, or null when
// all picks are exhausted or all participants are opted out.
export function computeNextPicker(
  currentPickNumber: number,
  entries: DraftOrderEntry[]
): string | null {
  const N = entries.length;
  if (N === 0) return null;

  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const maxGlobalSlots = REDRAFT_ROUNDS * N;

  let seen = 0;
  for (let i = 1; i <= maxGlobalSlots; i++) {
    const position = resolveDraftPosition(i, N, REDRAFT_ROUNDS);
    const entry = sorted[position - 1];
    if (!entry.optedOut) {
      seen++;
      if (seen === currentPickNumber) return entry.managerId;
    }
  }
  return null;
}

// Returns true if the redraft has no further active picks at or beyond
// currentPickNumber.
export function isRedraftExhausted(
  currentPickNumber: number,
  entries: DraftOrderEntry[]
): boolean {
  return computeNextPicker(currentPickNumber, entries) === null;
}

// Frozen-pool membership: player is in the pool if NOT a manager-drop waiver.
// Used to validate picks and build auto-pick candidates.
export function isInFrozenPool(
  status: "rostered" | "on_waivers" | "free_agent",
  dropReason: "mass_release" | "manager_drop" | null
): boolean {
  if (status === "rostered") return false;
  if (status === "free_agent") return true;
  return dropReason !== "manager_drop";
}

// By-need sort: auto-drops DESC, group-stage points DESC, highest single score DESC.
export function sortByNeed(entries: ByNeedEntry[]): ByNeedEntry[] {
  return [...entries].sort((a, b) => {
    if (a.autoDroppedCount !== b.autoDroppedCount)
      return b.autoDroppedCount - a.autoDroppedCount;
    if (a.groupStagePoints !== b.groupStagePoints)
      return b.groupStagePoints - a.groupStagePoints;
    return b.highestSingleScore - a.highestSingleScore;
  });
}

// Auto-pick selection: highest group-stage points from the pool, filtered to
// positions the manager can legally add (§5 maxes). Never drops to make room.
export function selectAutoPick(
  pool: Array<{
    playerId: string;
    fantasyPosition: "GK" | "DEF" | "MID" | "FWD";
    groupStagePoints: number;
  }>,
  rosterPositions: Array<"GK" | "DEF" | "MID" | "FWD">
): string | null {
  const counts: Record<string, number> = {};
  for (const pos of rosterPositions) {
    counts[pos] = (counts[pos] ?? 0) + 1;
  }

  const eligible = pool.filter(
    (p) => (counts[p.fantasyPosition] ?? 0) < POSITION_MAX[p.fantasyPosition]
  );
  if (eligible.length === 0) return null;

  return eligible.reduce((best, p) =>
    p.groupStagePoints > best.groupStagePoints ? p : best
  ).playerId;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function getDraftOrderEntries(draftId: string): Promise<DraftOrderEntry[]> {
  return db
    .select({
      id: draftOrder.id,
      managerId: draftOrder.managerId,
      position: draftOrder.position,
      optedOut: draftOrder.optedOut,
    })
    .from(draftOrder)
    .where(eq(draftOrder.draftId, draftId));
}

// ── computeByNeedOrder ─────────────────────────────────────────────────────────

export async function computeByNeedOrder(leagueId: string): Promise<ByNeedEntry[]> {
  const [advancingManagers, dropCounts, standings] = await Promise.all([
    db
      .select({ id: leagueMemberships.id })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, leagueId),
          isNull(leagueMemberships.eliminatedAtRound)
        )
      ),
    db
      .select({
        droppedByManagerId: waiverPlayerStatus.droppedByManagerId,
        cnt: sql<string>`count(*)`,
      })
      .from(waiverPlayerStatus)
      .where(
        and(
          eq(waiverPlayerStatus.leagueId, leagueId),
          eq(waiverPlayerStatus.dropReason, "mass_release"),
          isNotNull(waiverPlayerStatus.droppedByManagerId)
        )
      )
      .groupBy(waiverPlayerStatus.droppedByManagerId),
    db
      .select({
        managerId: groupStandings.managerId,
        pointsFor: groupStandings.pointsFor,
        highestSingleScore: groupStandings.highestSingleScore,
      })
      .from(groupStandings)
      .where(eq(groupStandings.leagueId, leagueId)),
  ]);

  const dropMap = new Map<string, number>();
  for (const r of dropCounts) {
    if (r.droppedByManagerId) {
      dropMap.set(r.droppedByManagerId, parseInt(r.cnt, 10));
    }
  }

  const standingsMap = new Map<
    string,
    { pointsFor: number; highestSingleScore: number }
  >();
  for (const r of standings) {
    standingsMap.set(r.managerId, {
      pointsFor: parseFloat(r.pointsFor ?? "0"),
      highestSingleScore: parseFloat(r.highestSingleScore ?? "0"),
    });
  }

  const raw: ByNeedEntry[] = advancingManagers.map((m) => {
    const s = standingsMap.get(m.id) ?? { pointsFor: 0, highestSingleScore: 0 };
    return {
      managerId: m.id,
      autoDroppedCount: dropMap.get(m.id) ?? 0,
      groupStagePoints: s.pointsFor,
      highestSingleScore: s.highestSingleScore,
    };
  });

  return sortByNeed(raw);
}

// ── startRedraft ───────────────────────────────────────────────────────────────

export async function startRedraft(leagueId: string): Promise<{ draftId: string }> {
  const [league] = await db
    .select({
      status: leagues.status,
      massReleaseCompletedAt: leagues.massReleaseCompletedAt,
      redraftPoolFrozenAt: leagues.redraftPoolFrozenAt,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${leagueId} not found`);
  if (league.status !== "group_stage")
    throw new Error(`League must be in group_stage status to start redraft (got: ${league.status})`);
  if (!league.massReleaseCompletedAt)
    throw new Error(`Mass release must complete before starting the redraft`);
  if (league.redraftPoolFrozenAt)
    throw new Error(`Redraft already started for league ${leagueId}`);

  const byNeedOrder = await computeByNeedOrder(leagueId);
  if (byNeedOrder.length === 0)
    throw new Error(`No advancing managers found for league ${leagueId}`);

  const now = new Date();
  let draftId = "";

  await db.transaction(async (tx) => {
    // Re-check under lock
    const [lockedLeague] = await tx
      .select({ redraftPoolFrozenAt: leagues.redraftPoolFrozenAt })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for("update")
      .limit(1);

    if (lockedLeague?.redraftPoolFrozenAt) {
      // Already started by concurrent call — read the existing draft id
      const [existing] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
        .limit(1);
      draftId = existing?.id ?? "";
      return;
    }

    // UI-phase revisit: pick-1 clock starts at row creation, not at a "go live" signal.
    // For a live UI, startRedraft should create the draft with status='pending' and a
    // separate "begin picking" action should set status='active' + currentPickDeadline.
    const deadline = new Date(now.getTime() + REDRAFT_PICK_CLOCK_SECONDS * 1000);

    const [inserted] = await tx
      .insert(drafts)
      .values({
        leagueId,
        type: "redraft",
        status: "active",
        currentPickNumber: 1,
        pickClockSeconds: REDRAFT_PICK_CLOCK_SECONDS,
        startsAt: now,
        startedAt: now,
        currentPickStartedAt: now,
        currentPickDeadline: deadline,
      })
      .returning({ id: drafts.id });

    draftId = inserted.id;

    // Transition league status and record frozen-at timestamp
    await tx
      .update(leagues)
      .set({
        status: "redrafting",
        redraftPoolFrozenAt: now,
        updatedAt: now,
      })
      .where(eq(leagues.id, leagueId));

    // Create draft_order rows from by-need order
    for (let i = 0; i < byNeedOrder.length; i++) {
      await tx.insert(draftOrder).values({
        draftId,
        position: i + 1,
        managerId: byNeedOrder[i].managerId,
      });
    }
  });

  return { draftId };
}

// ── getRedraftState ────────────────────────────────────────────────────────────

export async function getRedraftState(leagueId: string): Promise<RedraftState> {
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
    .limit(1);

  if (!draft) throw new Error(`No redraft found for league ${leagueId}`);

  if (draft.status !== "active") {
    return {
      draft,
      isExpired: false,
      expiresAt: null,
      onTheClockManagerId: null,
      isComplete: draft.status === "complete",
    };
  }

  const now = new Date();
  const expiresAt = draft.currentPickDeadline ?? null;
  const isExpired = expiresAt !== null && now > expiresAt;

  const entries = await getDraftOrderEntries(draft.id);
  const onTheClockManagerId = draft.currentPickNumber !== null
    ? computeNextPicker(draft.currentPickNumber, entries)
    : null;

  return {
    draft,
    isExpired,
    expiresAt,
    onTheClockManagerId,
    isComplete: false,
  };
}

// ── submitRedraftPick ──────────────────────────────────────────────────────────

export type SubmitRedraftPickArgs = {
  leagueId: string;
  managerId: string;
  playerId: string;
  dropPlayerId?: string;
};

export async function submitRedraftPick(
  args: SubmitRedraftPickArgs
): Promise<{ pickNumber: number; isFinalPick: boolean }> {
  const { leagueId, managerId, playerId, dropPlayerId } = args;
  const now = new Date();

  const state = await getRedraftState(leagueId);
  if (state.draft.status !== "active") {
    throw new Error(`Redraft is not active (status: ${state.draft.status})`);
  }

  if (state.onTheClockManagerId !== managerId) {
    throw new Error(
      `Manager ${managerId} is not on the clock (expected ${state.onTheClockManagerId})`
    );
  }

  if (state.isExpired) {
    throw new Error(`Pick clock has expired for pick ${state.draft.currentPickNumber}`);
  }

  // Validate player is in the frozen pool
  const [playerStatus] = await db
    .select({
      status: waiverPlayerStatus.status,
      dropReason: waiverPlayerStatus.dropReason,
    })
    .from(waiverPlayerStatus)
    .where(
      and(
        eq(waiverPlayerStatus.leagueId, leagueId),
        eq(waiverPlayerStatus.playerId, playerId)
      )
    )
    .limit(1);

  if (!playerStatus) {
    throw new Error(`Player ${playerId} not found in league ${leagueId}`);
  }
  if (!isInFrozenPool(playerStatus.status, playerStatus.dropReason)) {
    throw new Error(
      `Player ${playerId} is not in the redraft pool (status: ${playerStatus.status}, reason: ${playerStatus.dropReason})`
    );
  }

  // Get player position
  const [playerRow] = await db
    .select({ fantasyPosition: players.fantasyPosition })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);

  if (!playerRow) throw new Error(`Player ${playerId} does not exist`);

  // Get manager's current roster (positions)
  const rosterRows = await db
    .select({ fantasyPosition: players.fantasyPosition })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)));

  const rosterSize = rosterRows.length;

  // Full-roster rule: must drop if at 14
  if (rosterSize >= 14 && !dropPlayerId) {
    throw new Error(
      `Manager ${managerId} is at 14 players; must specify a drop player`
    );
  }

  // Position max check (accounting for the drop)
  const positionCounts: Record<string, number> = {};
  for (const r of rosterRows) {
    positionCounts[r.fantasyPosition] = (positionCounts[r.fantasyPosition] ?? 0) + 1;
  }
  if (dropPlayerId) {
    // The dropped player's position will be freed; fetch it
    const [dropRow] = await db
      .select({ fantasyPosition: players.fantasyPosition })
      .from(rosters)
      .innerJoin(players, eq(rosters.playerId, players.id))
      .where(
        and(
          eq(rosters.leagueId, leagueId),
          eq(rosters.managerId, managerId),
          eq(rosters.playerId, dropPlayerId)
        )
      )
      .limit(1);

    if (!dropRow) {
      throw new Error(
        `Drop player ${dropPlayerId} is not on manager ${managerId}'s roster`
      );
    }
    positionCounts[dropRow.fantasyPosition] =
      (positionCounts[dropRow.fantasyPosition] ?? 0) - 1;
  }

  const newCount = (positionCounts[playerRow.fantasyPosition] ?? 0) + 1;
  if (newCount > POSITION_MAX[playerRow.fantasyPosition]) {
    throw new Error(
      `Adding this player would give manager ${managerId} ${newCount} ${playerRow.fantasyPosition}s, exceeding the maximum of ${POSITION_MAX[playerRow.fantasyPosition]}`
    );
  }

  let pickNumber = 0;
  let isComplete = false;

  await db.transaction(async (tx) => {
    // Lock the draft row
    const [lockedDraft] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
      .for("update")
      .limit(1);

    if (!lockedDraft || lockedDraft.status !== "active") {
      throw new Error("Redraft is no longer active");
    }
    if (lockedDraft.currentPickNumber !== state.draft.currentPickNumber) {
      throw new Error(
        `Pick number mismatch: expected ${state.draft.currentPickNumber} but draft is now at ${lockedDraft.currentPickNumber}`
      );
    }

    pickNumber = lockedDraft.currentPickNumber!;

    // Add player to roster
    await applyOwnershipTransition(
      tx,
      leagueId,
      playerId,
      { to: "rostered", managerId, acquiredVia: "redraft" },
      now
    );

    // Conditional drop
    if (dropPlayerId) {
      await applyOwnershipTransition(
        tx,
        leagueId,
        dropPlayerId,
        {
          to: "on_waivers",
          dropReason: "manager_drop",
          droppedByManagerId: managerId,
          eligibleAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        },
        now
      );
    }

    // Record the pick
    await tx.insert(draftPicks).values({
      draftId: lockedDraft.id,
      pickNumber,
      managerId,
      playerId,
      droppedPlayerId: dropPlayerId ?? null,
      clockExpired: false,
    });

    // Advance or complete
    const entries = await getDraftOrderEntries(lockedDraft.id);
    const nextPickNumber = pickNumber + 1;
    const nextManager = computeNextPicker(nextPickNumber, entries);

    if (nextManager === null) {
      isComplete = true;
      await tx
        .update(drafts)
        .set({
          status: "complete",
          currentPickNumber: null,
          currentPickStartedAt: null,
          currentPickDeadline: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(drafts.id, lockedDraft.id));
    } else {
      const nextDeadline = new Date(
        now.getTime() + REDRAFT_PICK_CLOCK_SECONDS * 1000
      );
      await tx
        .update(drafts)
        .set({
          currentPickNumber: nextPickNumber,
          currentPickStartedAt: now,
          currentPickDeadline: nextDeadline,
          updatedAt: now,
        })
        .where(eq(drafts.id, lockedDraft.id));
    }
  });

  return { pickNumber, isFinalPick: isComplete };
}

// ── optOutOfRedraft ────────────────────────────────────────────────────────────

export async function optOutOfRedraft(
  leagueId: string,
  managerId: string
): Promise<{ isComplete: boolean }> {
  let isComplete = false;

  await db.transaction(async (tx) => {
    const [lockedDraft] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
      .for("update")
      .limit(1);

    if (!lockedDraft || lockedDraft.status !== "active") {
      throw new Error("Redraft is not active");
    }

    // Verify manager is a participant
    const [orderRow] = await tx
      .select({ id: draftOrder.id, optedOut: draftOrder.optedOut })
      .from(draftOrder)
      .where(
        and(
          eq(draftOrder.draftId, lockedDraft.id),
          eq(draftOrder.managerId, managerId)
        )
      )
      .limit(1);

    if (!orderRow) {
      throw new Error(`Manager ${managerId} is not a redraft participant`);
    }
    if (orderRow.optedOut) return; // already opted out — idempotent

    const now = new Date();

    await tx
      .update(draftOrder)
      .set({ optedOut: true, updatedAt: now })
      .where(eq(draftOrder.id, orderRow.id));

    // Re-read all entries to check if the draft is now exhausted
    const entries = await getDraftOrderEntries(lockedDraft.id);

    const currentPickNumber = lockedDraft.currentPickNumber ?? 1;
    const nextManager = computeNextPicker(currentPickNumber, entries);

    if (nextManager === null) {
      isComplete = true;
      await tx
        .update(drafts)
        .set({
          status: "complete",
          currentPickNumber: null,
          currentPickStartedAt: null,
          currentPickDeadline: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(drafts.id, lockedDraft.id));
    }
  });

  return { isComplete };
}

// ── resolveExpiredRedraftPick ──────────────────────────────────────────────────

export type ExpiredPickAction =
  | { action: "not_expired" }
  | { action: "already_complete" }
  | { action: "skip"; reason: "roster_full" | "no_eligible_player" }
  | { action: "auto_pick"; playerId: string; pickNumber: number };

export async function resolveExpiredRedraftPick(
  leagueId: string
): Promise<ExpiredPickAction> {
  const state = await getRedraftState(leagueId);

  if (state.isComplete || state.draft.status !== "active") {
    return { action: "already_complete" };
  }
  if (!state.isExpired) {
    return { action: "not_expired" };
  }

  const managerId = state.onTheClockManagerId;
  if (!managerId) return { action: "already_complete" };

  const now = new Date();

  // Get manager's roster size and positions
  const rosterRows = await db
    .select({ playerId: rosters.playerId, fantasyPosition: players.fantasyPosition })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)));

  const rosterSize = rosterRows.length;

  // No open slot → skip, no auto-drop
  if (rosterSize >= 14) {
    return await advancePick(leagueId, state, now, null, "roster_full");
  }

  // Get frozen pool (non-rostered, not manager-drop)
  const poolRows = await db
    .select({
      playerId: waiverPlayerStatus.playerId,
      status: waiverPlayerStatus.status,
      dropReason: waiverPlayerStatus.dropReason,
    })
    .from(waiverPlayerStatus)
    .where(eq(waiverPlayerStatus.leagueId, leagueId));

  const eligiblePlayerIds = poolRows
    .filter(
      (r) =>
        isInFrozenPool(r.status, r.dropReason) &&
        !rosterRows.some((rr) => rr.playerId === r.playerId)
    )
    .map((r) => r.playerId);

  if (eligiblePlayerIds.length === 0) {
    return await advancePick(leagueId, state, now, null, "no_eligible_player");
  }

  // Get player positions and group-stage points for the pool
  const poolPlayerRows = await db
    .select({ id: players.id, fantasyPosition: players.fantasyPosition })
    .from(players)
    .where(inArray(players.id, eligiblePlayerIds));

  const pointsRows = await db
    .select({
      playerId: playerMatchScores.playerId,
      total: sql<string>`sum(${playerMatchScores.points})`,
    })
    .from(playerMatchScores)
    .innerJoin(realFixtures, eq(playerMatchScores.fixtureId, realFixtures.id))
    .where(
      and(
        inArray(playerMatchScores.playerId, eligiblePlayerIds),
        inArray(realFixtures.round, ["group_md1", "group_md2", "group_md3"])
      )
    )
    .groupBy(playerMatchScores.playerId);

  const pointsMap = new Map<string, number>();
  for (const r of pointsRows) {
    pointsMap.set(r.playerId, parseFloat(r.total ?? "0"));
  }

  const pool = poolPlayerRows.map((p) => ({
    playerId: p.id,
    fantasyPosition: p.fantasyPosition,
    groupStagePoints: pointsMap.get(p.id) ?? 0,
  }));

  const rosterPositions = rosterRows.map((r) => r.fantasyPosition);
  const autoPickId = selectAutoPick(pool, rosterPositions);

  if (!autoPickId) {
    return await advancePick(leagueId, state, now, null, "no_eligible_player");
  }

  const result = await advancePick(leagueId, state, now, autoPickId, null);
  return result;
}

// Applies an auto-pick (or skip) and advances the draft.
async function advancePick(
  leagueId: string,
  state: RedraftState,
  now: Date,
  autoPickPlayerId: string | null,
  skipReason: "roster_full" | "no_eligible_player" | null
): Promise<ExpiredPickAction> {
  let pickNumber = 0;
  let isComplete = false;

  await db.transaction(async (tx) => {
    const [lockedDraft] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
      .for("update")
      .limit(1);

    if (!lockedDraft || lockedDraft.status !== "active") return;
    if (lockedDraft.currentPickNumber !== state.draft.currentPickNumber) return;

    // Verify still expired under lock
    const deadline = lockedDraft.currentPickDeadline;
    if (deadline && now <= deadline) return;

    pickNumber = lockedDraft.currentPickNumber!;
    const managerId = state.onTheClockManagerId!;

    if (autoPickPlayerId) {
      await applyOwnershipTransition(
        tx,
        leagueId,
        autoPickPlayerId,
        { to: "rostered", managerId, acquiredVia: "redraft" },
        now
      );

      await tx.insert(draftPicks).values({
        draftId: lockedDraft.id,
        pickNumber,
        managerId,
        playerId: autoPickPlayerId,
        droppedPlayerId: null,
        clockExpired: true,
      });
    }
    // Skip: no pick row inserted — manager just loses their turn

    const entries = await getDraftOrderEntries(lockedDraft.id);
    const nextManager = computeNextPicker(pickNumber + 1, entries);

    if (nextManager === null) {
      isComplete = true;
      await tx
        .update(drafts)
        .set({
          status: "complete",
          currentPickNumber: null,
          currentPickStartedAt: null,
          currentPickDeadline: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(drafts.id, lockedDraft.id));
    } else {
      const nextDeadline = new Date(
        now.getTime() + REDRAFT_PICK_CLOCK_SECONDS * 1000
      );
      await tx
        .update(drafts)
        .set({
          currentPickNumber: pickNumber + 1,
          currentPickStartedAt: now,
          currentPickDeadline: nextDeadline,
          updatedAt: now,
        })
        .where(eq(drafts.id, lockedDraft.id));
    }
  });

  if (isComplete || pickNumber === 0) {
    // pickNumber=0 means concurrent resolution won the lock
    if (autoPickPlayerId) {
      return { action: "auto_pick", playerId: autoPickPlayerId, pickNumber };
    }
    return { action: "skip", reason: skipReason ?? "no_eligible_player" };
  }

  if (autoPickPlayerId) {
    return { action: "auto_pick", playerId: autoPickPlayerId, pickNumber };
  }
  return { action: "skip", reason: skipReason ?? "no_eligible_player" };
}
