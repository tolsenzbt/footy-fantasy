const VALID_LEAGUE_SIZES = new Set([8, 12, 16]);

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

function validate(pickNumber: number, leagueSize: number): void {
  if (!VALID_LEAGUE_SIZES.has(leagueSize)) {
    throw new Error(
      `Invalid leagueSize ${leagueSize}. Must be 8, 12, or 16.`
    );
  }
  if (pickNumber < 1 || pickNumber > 14 * leagueSize) {
    throw new Error(
      `pickNumber ${pickNumber} out of range for leagueSize ${leagueSize} (valid: 1–${14 * leagueSize}).`
    );
  }
}

export function pickToRound(
  pickNumber: number,
  leagueSize: number
): { round: number; pickInRound: number } {
  validate(pickNumber, leagueSize);
  const round = Math.ceil(pickNumber / leagueSize);
  const pickInRound = ((pickNumber - 1) % leagueSize) + 1;
  return { round, pickInRound };
}

export function resolveDraftPosition(
  pickNumber: number,
  leagueSize: number
): number {
  const { round, pickInRound } = pickToRound(pickNumber, leagueSize);
  // Odd rounds: pick goes 1→N. Even rounds: snake flips, pick goes N→1.
  return round % 2 === 1 ? pickInRound : leagueSize - pickInRound + 1;
}
