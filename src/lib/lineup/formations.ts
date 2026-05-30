export type Formation =
  | "3-4-3"
  | "3-5-2"
  | "4-3-3"
  | "4-4-2"
  | "4-5-1"
  | "5-3-2"
  | "5-4-1";

export const VALID_FORMATIONS: readonly Formation[] = [
  "3-4-3",
  "3-5-2",
  "4-3-3",
  "4-4-2",
  "4-5-1",
  "5-3-2",
  "5-4-1",
];

export type FormationBreakdown = { gk: 1; def: number; mid: number; fwd: number };

export function parseFormation(f: string): FormationBreakdown {
  if (!isValidFormation(f)) throw new Error(`Invalid formation: "${f}"`);
  const [def, mid, fwd] = f.split("-").map(Number);
  return { gk: 1, def, mid, fwd };
}

export function isValidFormation(f: string): f is Formation {
  return (VALID_FORMATIONS as readonly string[]).includes(f);
}

export function inferFormation(
  positions: Array<"GK" | "DEF" | "MID" | "FWD">
): Formation | null {
  if (positions.length !== 11) return null;

  let gk = 0, def = 0, mid = 0, fwd = 0;
  for (const p of positions) {
    if (p === "GK") gk++;
    else if (p === "DEF") def++;
    else if (p === "MID") mid++;
    else fwd++;
  }

  if (gk !== 1) return null;

  const candidate = `${def}-${mid}-${fwd}`;
  return isValidFormation(candidate) ? candidate : null;
}
