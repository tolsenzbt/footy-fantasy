export type FantasyRoundId = "group_md1" | "group_md2" | "group_md3" | "qf" | "sf" | "final";

export function mapRound(roundStr: string): FantasyRoundId | null {
  const r = roundStr.toLowerCase();
  if (r.includes("group stage - 1") || r === "group stage - matchday 1") return "group_md1";
  if (r.includes("group stage - 2") || r === "group stage - matchday 2") return "group_md2";
  if (r.includes("group stage - 3") || r === "group stage - matchday 3") return "group_md3";
  const matchRound = r.match(/group stage\s*-\s*(\d+)/);
  if (matchRound) {
    const n = parseInt(matchRound[1]);
    if (n === 1) return "group_md1";
    if (n === 2) return "group_md2";
    if (n === 3) return "group_md3";
  }
  if (r.includes("round of 32")) return "qf";
  if (r.includes("round of 16") && !r.includes("round of 16 - 2")) return "sf";
  if (r.includes("round of 16 - 2")) return "qf";
  if (r.includes("quarter-final") || r.includes("quarterfinal")) return "final";
  return null;
}

export const ROUND_ORDER: Record<FantasyRoundId, number> = {
  group_md1: 0,
  group_md2: 1,
  group_md3: 2,
  qf: 3,
  sf: 4,
  final: 5,
};
