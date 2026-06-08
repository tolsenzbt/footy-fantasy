import "server-only";
import { isValidFormation, parseFormation } from "./formations";

export type RosterPlayer = {
  playerId: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  nationKickoffAt: Date | null;
};

export type ExistingSlot = {
  playerId: string;
  slotType: "starter" | "bench";
  lockedAt: Date | null;
};

export type PreviousLineup = {
  captainPlayerId: string | null;
  vcPlayerId: string | null;
  captainLockedAt: Date | null;
  vcLockedAt: Date | null;
  slots: ExistingSlot[];
};

export type LineupSubmission = {
  formation: string;
  starterPlayerIds: string[];
  benchPlayerIds: string[];
  captainPlayerId: string;
  vcPlayerId: string;
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateLineup(
  sub: LineupSubmission,
  roster: RosterPlayer[],
  prev: PreviousLineup | null,
  now: Date
): ValidationResult {
  const allIds = [...sub.starterPlayerIds, ...sub.benchPlayerIds];

  // Rule 1: exactly 14 players
  if (allIds.length !== 14) {
    return { ok: false, error: `Expected 14 players, got ${allIds.length}` };
  }

  // Rule 2: all in roster, no duplicates
  const rosterMap = new Map(roster.map(r => [r.playerId, r]));
  const seen = new Set<string>();
  for (const id of allIds) {
    if (!rosterMap.has(id)) return { ok: false, error: `Player ${id} not on roster` };
    if (seen.has(id)) return { ok: false, error: `Duplicate player ${id}` };
    seen.add(id);
  }

  // Rule 3: 11 starters, 3 bench
  if (sub.starterPlayerIds.length !== 11) {
    return { ok: false, error: `Expected 11 starters, got ${sub.starterPlayerIds.length}` };
  }
  if (sub.benchPlayerIds.length !== 3) {
    return { ok: false, error: `Expected 3 bench, got ${sub.benchPlayerIds.length}` };
  }

  // Rule 4: valid formation and starters match it
  if (!isValidFormation(sub.formation)) {
    return { ok: false, error: `Invalid formation: "${sub.formation}"` };
  }
  const breakdown = parseFormation(sub.formation);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of sub.starterPlayerIds) counts[rosterMap.get(id)!.position]++;
  if (
    counts.GK !== breakdown.gk ||
    counts.DEF !== breakdown.def ||
    counts.MID !== breakdown.mid ||
    counts.FWD !== breakdown.fwd
  ) {
    return { ok: false, error: `Starter positions don't match formation ${sub.formation}` };
  }

  // Rule 5: captain is in starting XI
  const starterSet = new Set(sub.starterPlayerIds);
  if (!starterSet.has(sub.captainPlayerId)) {
    return { ok: false, error: "Captain must be in starting XI" };
  }

  // Rule 6: VC is in starting XI and differs from captain
  if (!starterSet.has(sub.vcPlayerId)) {
    return { ok: false, error: "Vice-captain must be in starting XI" };
  }
  if (sub.vcPlayerId === sub.captainPlayerId) {
    return { ok: false, error: "Captain and vice-captain must be different players" };
  }

  // Rules 7–8: lock enforcement (only when a previous lineup exists)
  if (prev !== null) {
    const prevSlotMap = new Map(prev.slots.map(s => [s.playerId, s]));

    const isLocked = (playerId: string): boolean => {
      const slot = prevSlotMap.get(playerId);
      if (slot && slot.lockedAt !== null) return true;
      const rp = rosterMap.get(playerId);
      if (rp?.nationKickoffAt && rp.nationKickoffAt <= now) return true;
      return false;
    };

    // Rule 7a: locked slots can't be moved or removed
    for (const slot of prev.slots) {
      if (!isLocked(slot.playerId)) continue;
      if (!seen.has(slot.playerId)) {
        return { ok: false, error: `Player ${slot.playerId} is locked and cannot be removed` };
      }
      const newType = starterSet.has(slot.playerId) ? "starter" : "bench";
      if (newType !== slot.slotType) {
        return { ok: false, error: `Player ${slot.playerId} is locked as ${slot.slotType}` };
      }
    }

    // Rule 7b: captain lock
    const captainLocked =
      prev.captainLockedAt !== null ||
      (prev.captainPlayerId !== null && isLocked(prev.captainPlayerId));
    if (captainLocked && sub.captainPlayerId !== prev.captainPlayerId) {
      return { ok: false, error: "Captain is locked and cannot be changed" };
    }

    // Rule 7c: VC lock
    const vcLocked =
      prev.vcLockedAt !== null ||
      (prev.vcPlayerId !== null && isLocked(prev.vcPlayerId));
    if (vcLocked && sub.vcPlayerId !== prev.vcPlayerId) {
      return { ok: false, error: "Vice-captain is locked and cannot be changed" };
    }

    // Rule 8: new captain/VC designee must not be locked
    if (sub.captainPlayerId !== prev.captainPlayerId && isLocked(sub.captainPlayerId)) {
      return { ok: false, error: "Cannot designate a locked player as captain" };
    }
    if (sub.vcPlayerId !== prev.vcPlayerId && isLocked(sub.vcPlayerId)) {
      return { ok: false, error: "Cannot designate a locked player as vice-captain" };
    }
  }

  return { ok: true };
}
