import { applyCaptainMultiplier } from "@/lib/scoring/engine";

// Per-player output from the shared scorer.
export type ScoredPlayer = {
  playerId: string;
  basePoints: number;
  multiplier: 1 | 2;
  finalPoints: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
};

// Core scoring computation shared by resolveMatchups (writer) and
// getMatchupsForRound (reader), ensuring both produce identical numbers
// from identical data.
//
// Inputs:
//   basesMap         playerId → effective base (overridePoints ?? points from
//                    player_match_scores, or 0 for a missing row)
//   captainMinutesPlayed  from player_match_stats for the captain player only
//
// Captain/VC rules (matching scoreStartingXI semantics):
//   captainPlayed = captainMinutesPlayed > 0
//   vcPromotes    = !captainPlayed && vcPlayerId !== null
//   recipient     = vcPromotes ? vcPlayerId : captainPlayerId
//   recipientBonus = captainPlayed || vcPromotes → recipient gets 2x
//   no captain set → 1x for everyone (including any VC)
export function scoreLineupBases(
  starters: ReadonlyArray<{ playerId: string }>,
  basesMap: Map<string, number>,
  captainPlayerId: string | null,
  vcPlayerId: string | null,
  captainMinutesPlayed: number,
): { players: ScoredPlayer[]; total: number } {
  let recipientId: string | null = null;
  let recipientBonus = false;

  if (captainPlayerId !== null) {
    const captainPlayed = captainMinutesPlayed > 0;
    const vcPromotes = !captainPlayed && vcPlayerId !== null;
    recipientId = vcPromotes ? vcPlayerId : captainPlayerId;
    recipientBonus = captainPlayed || vcPromotes;
  }

  let total = 0;
  const players: ScoredPlayer[] = starters.map(({ playerId }) => {
    const base = basesMap.get(playerId) ?? 0;
    const isRecipient = recipientBonus && playerId === recipientId;
    const finalPoints = applyCaptainMultiplier(base, isRecipient);
    const multiplier: 1 | 2 = isRecipient ? 2 : 1;
    total += finalPoints;
    return {
      playerId,
      basePoints: base,
      multiplier,
      finalPoints,
      isCaptain: playerId === captainPlayerId,
      isViceCaptain: playerId === vcPlayerId,
    };
  });

  return { players, total };
}
