export function leagueSizeFromFormat(
  format: "eight" | "twelve" | "sixteen"
): number {
  switch (format) {
    case "eight":
      return 8;
    case "twelve":
      return 12;
    case "sixteen":
      return 16;
  }
}

function validate(pickNumber: number, participantCount: number, totalRounds: number): void {
  if (participantCount < 1) {
    throw new Error(
      `Invalid participantCount ${participantCount}. Must be >= 1.`
    );
  }
  if (totalRounds < 1) {
    throw new Error(`Invalid totalRounds ${totalRounds}. Must be >= 1.`);
  }
  if (pickNumber < 1 || pickNumber > totalRounds * participantCount) {
    throw new Error(
      `pickNumber ${pickNumber} out of range (valid: 1–${totalRounds * participantCount} for participantCount=${participantCount}, totalRounds=${totalRounds}).`
    );
  }
}

export function pickToRound(
  pickNumber: number,
  participantCount: number,
  totalRounds: number
): { round: number; pickInRound: number } {
  validate(pickNumber, participantCount, totalRounds);
  const round = Math.ceil(pickNumber / participantCount);
  const pickInRound = ((pickNumber - 1) % participantCount) + 1;
  return { round, pickInRound };
}

export function resolveDraftPosition(
  pickNumber: number,
  participantCount: number,
  totalRounds: number
): number {
  const { round, pickInRound } = pickToRound(pickNumber, participantCount, totalRounds);
  return round % 2 === 1 ? pickInRound : participantCount - pickInRound + 1;
}
