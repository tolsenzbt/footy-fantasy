export type WaiverPriorityEntry = {
  managerId: string;
  priority: number; // 1 = highest
};

export type WaiverClaim = {
  id: string;
  managerId: string;
  playerId: string;
  dropPlayerId: string | null;
  rank: number; // lower = higher priority among this manager's claims
};

export type AwardTransaction = {
  type: "award";
  claimId: string;
  managerId: string;
  playerId: string;
  dropPlayerId: string | null;
};

export type FailTransaction = {
  type: "fail";
  claimId: string;
  managerId: string;
  reason: "not_available";
};

export type InvalidTransaction = {
  type: "invalid";
  claimId: string;
  managerId: string;
  reason: "roster_full_no_drop" | "drop_not_on_roster";
};

export type VoidTransaction = {
  type: "void";
  claimId: string;
  managerId: string;
  reason: "drop_already_used";
};

export type WaiverTransaction =
  | AwardTransaction
  | FailTransaction
  | InvalidTransaction
  | VoidTransaction;

export type WaiverSnapshot = {
  priorityOrder: WaiverPriorityEntry[]; // need not be pre-sorted
  claims: WaiverClaim[];
  rosters: Map<string, Set<string>>; // managerId -> Set<playerId>
  availablePlayers: Set<string>; // player IDs eligible for award this round
  maxRosterSize: number;
};

export type WaiverResult = {
  transactions: WaiverTransaction[];
  finalPriorityOrder: WaiverPriorityEntry[];
};

export function processWaivers(snapshot: WaiverSnapshot): WaiverResult {
  const { maxRosterSize } = snapshot;

  // Working copies
  const available = new Set(snapshot.availablePlayers);

  const effectiveRosters = new Map<string, Set<string>>();
  for (const [mgr, players] of snapshot.rosters) {
    effectiveRosters.set(mgr, new Set(players));
  }

  // Group claims by manager, sorted by rank ascending
  const claimsByManager = new Map<string, WaiverClaim[]>();
  for (const claim of snapshot.claims) {
    const list = claimsByManager.get(claim.managerId) ?? [];
    list.push(claim);
    claimsByManager.set(claim.managerId, list);
  }
  for (const list of claimsByManager.values()) {
    list.sort((a, b) => a.rank - b.rank);
  }

  const processedClaims = new Set<string>();
  const transactions: WaiverTransaction[] = [];

  // Priority order: ascending = highest first; track next slot for bottom
  let currentPriority = [...snapshot.priorityOrder].sort(
    (a, b) => a.priority - b.priority
  );
  let nextBottomPriority =
    (currentPriority.at(-1)?.priority ?? 0) + 1;

  // Fixpoint: keep looping until a full pass over all managers produces no award
  let madeAward = true;
  while (madeAward) {
    madeAward = false;

    for (const { managerId } of currentPriority) {
      const allClaims = claimsByManager.get(managerId) ?? [];
      const pending = allClaims.filter((c) => !processedClaims.has(c.id));
      if (pending.length === 0) continue;

      const roster = effectiveRosters.get(managerId) ?? new Set<string>();

      // Find first claim that can be awarded now
      let awardedClaim: WaiverClaim | null = null;
      for (const claim of pending) {
        if (!available.has(claim.playerId)) continue;

        const hasSpace = roster.size < maxRosterSize;
        const dropOnRoster =
          claim.dropPlayerId !== null && roster.has(claim.dropPlayerId);

        if (hasSpace || dropOnRoster) {
          awardedClaim = claim;
          break;
        }
        // Roster full and drop not on roster (or no drop) — skip for now
      }

      if (awardedClaim === null) continue;

      // Award
      const { id, dropPlayerId, playerId } = awardedClaim;
      processedClaims.add(id);
      available.delete(playerId);
      roster.add(playerId);

      // Execute conditional drop (check after adding playerId; dropPlayerId is a different player)
      const doingDrop = dropPlayerId !== null && roster.has(dropPlayerId);
      if (doingDrop) {
        roster.delete(dropPlayerId!);

        // Auto-void other pending claims sharing this drop player
        for (const c of allClaims) {
          if (!processedClaims.has(c.id) && c.dropPlayerId === dropPlayerId) {
            processedClaims.add(c.id);
            transactions.push({
              type: "void",
              claimId: c.id,
              managerId,
              reason: "drop_already_used",
            });
          }
        }
      }

      transactions.push({
        type: "award",
        claimId: id,
        managerId,
        playerId,
        dropPlayerId: doingDrop ? dropPlayerId : null,
      });

      // Move manager to bottom of priority
      currentPriority = currentPriority.filter((e) => e.managerId !== managerId);
      currentPriority.push({ managerId, priority: nextBottomPriority++ });

      madeAward = true;
      break; // restart fixpoint from top of priority
    }
  }

  // Categorize all remaining unprocessed claims
  for (const claims of claimsByManager.values()) {
    for (const claim of claims) {
      if (processedClaims.has(claim.id)) continue;

      if (!available.has(claim.playerId)) {
        transactions.push({
          type: "fail",
          claimId: claim.id,
          managerId: claim.managerId,
          reason: "not_available",
        });
        continue;
      }

      // Player still available — award was blocked by roster constraints
      const roster =
        effectiveRosters.get(claim.managerId) ?? new Set<string>();
      const hasSpace = roster.size < maxRosterSize;
      const dropOnRoster =
        claim.dropPlayerId !== null && roster.has(claim.dropPlayerId);

      if (!hasSpace && !dropOnRoster) {
        const reason =
          claim.dropPlayerId !== null
            ? "drop_not_on_roster"
            : "roster_full_no_drop";
        transactions.push({
          type: "invalid",
          claimId: claim.id,
          managerId: claim.managerId,
          reason,
        });
      } else {
        // Awardable but not processed — shouldn't happen in a correct fixpoint
        transactions.push({
          type: "fail",
          claimId: claim.id,
          managerId: claim.managerId,
          reason: "not_available",
        });
      }
    }
  }

  return {
    transactions,
    finalPriorityOrder: currentPriority,
  };
}
