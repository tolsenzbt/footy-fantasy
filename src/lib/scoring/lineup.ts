import {
  scorePlayer,
  applyCaptainMultiplier,
  type PlayerMatchStats,
  type FantasyPosition,
} from "./engine";

export type LineupPlayer = {
  playerId: string;
  position: FantasyPosition;
  stats: PlayerMatchStats;
};

export type StartingXIInput = {
  players: LineupPlayer[]; // exactly 11
  captainId: string;
  vcId: string | null;
};

export type PlayerScore = {
  playerId: string;
  basePoints: number;
  multiplier: 1 | 2;
  finalPoints: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
};

export type LineupScore = {
  players: PlayerScore[];
  total: number;
};

export function scoreStartingXI(input: StartingXIInput): LineupScore {
  const { players, captainId, vcId } = input;

  // Defensive assertions — guards against caller bugs, not validation
  const captain = players.find(p => p.playerId === captainId);
  if (!captain) throw new Error(`Captain ${captainId} not in XI`);

  const vc = vcId !== null ? players.find(p => p.playerId === vcId) : null;
  if (vcId !== null && !vc) throw new Error(`VC ${vcId} not in XI`);

  // Pre-pass: resolve the single 2x recipient before scoring
  const captainPlayed = captain.stats.minutesPlayed > 0;
  const vcPromotes = !captainPlayed && vc !== null;

  // recipientId: who gets the multiplier applied
  // recipientBonus: whether that application is actually 2x
  //   (false when captain played 0 and no VC — caller bug magnet edge case)
  const recipientId = vcPromotes ? vcId! : captainId;
  const recipientBonus = captainPlayed || vcPromotes; // false only when cap=0 and no VC

  // Scoring pass
  const scoredPlayers: PlayerScore[] = players.map(p => {
    const basePoints = scorePlayer(p.stats, p.position);
    const isRecipient = p.playerId === recipientId;
    const finalPoints = applyCaptainMultiplier(basePoints, isRecipient && recipientBonus);
    const multiplier: 1 | 2 = isRecipient && recipientBonus ? 2 : 1;

    return {
      playerId: p.playerId,
      basePoints,
      multiplier,
      finalPoints,
      isCaptain: p.playerId === captainId,
      isViceCaptain: p.playerId === vcId,
    };
  });

  const total = scoredPlayers.reduce((sum, p) => sum + p.finalPoints, 0);

  return { players: scoredPlayers, total };
}
