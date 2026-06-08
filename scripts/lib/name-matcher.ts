// Shared player name-matching logic. Used by ingest-projections.ts and ingest-depth-charts.ts.

export type FantasyPosition = "GK" | "DEF" | "MID" | "FWD";

export type DbPlayer = {
  id: string;
  name: string;
  nationId: string;
  position: string;
};

export interface MatchSuccess {
  kind: "match";
  player: DbPlayer;
  step: string;
}
export interface MatchAmbiguous {
  kind: "ambiguous";
  reason: string;
  candidates: string[];
}

// ── Name normalization ────────────────────────────────────────────────────────
function decodeHtml(s: string): string {
  return s
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&agrave;/gi, "à")
    .replace(/&egrave;/gi, "è")
    .replace(/&auml;/gi, "ä")
    .replace(/&ouml;/gi, "ö")
    .replace(/&uuml;/gi, "ü")
    .replace(/&amp;/gi, "&");
}

export function normalizeName(name: string): string {
  return decodeHtml(name)
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .replace(/ß/g, "ss")
    .replace(/[Øø]/g, "o")
    .replace(/[Ææ]/g, "ae")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-‑‐]/g, " ")
    .replace(/\./g, "")
    .replace(/[''`‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function translitKey(norm: string): string {
  let s = norm;
  s = s.replace(/kh/g, "k");
  s = s.replace(/gh/g, "g");
  s = s.replace(/ph/g, "f");
  s = s.replace(/ck/g, "k");
  s = s.replace(/c/g, "k");
  s = s.replace(/([aeiou])y([aeiou])/g, "$1$2");
  s = s.replace(/(?<=\w)y(?=\w)/g, "i");
  s = s.replace(/y\b/g, "i");
  s = s.replace(/oo/g, "u");
  s = s.replace(/ou/g, "u");
  s = s.replace(/ee/g, "i");
  s = s.replace(/eo/g, "u");
  s = s.replace(/aw/g, "a");
  s = s.replace(/w/g, "v");
  s = s.replace(/(.)\1+/g, "$1");
  s = s.replace(/\b(bin|bint|abu|ibn|al|el|abd)\b/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function skeletonKey(s: string): string {
  return s
    .replace(/[aeiou]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fuzzy token matching ──────────────────────────────────────────────────────
function fuzzyTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  if (longer.startsWith(shorter) && shorter.length >= Math.ceil(longer.length * 0.4)) return true;
  if (shorter.length >= 4 && longer.endsWith(shorter)) return true;
  return false;
}

function fuzzySubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) => larger.some((lt) => fuzzyTokenMatch(st, lt)));
}

function skelSubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) =>
    larger.some((lt) => {
      if (st === lt) return true;
      const [srt, lng] = st.length <= lt.length ? [st, lt] : [lt, st];
      return srt.length >= 2 && lng.startsWith(srt);
    })
  );
}

function fuzzyOrSkelTokenMatch(a: string, b: string): boolean {
  if (fuzzyTokenMatch(a, b)) return true;
  const sA = skeletonKey(a);
  const sB = skeletonKey(b);
  if (sA !== sB || sA.length === 0) return false;
  const bigramsOf = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 1 < s.length; i++) set.add(s[i] + s[i + 1]);
    return set;
  };
  const ba = bigramsOf(a);
  const bb = bigramsOf(b);
  let shared = 0;
  for (const bg of ba) if (bb.has(bg)) shared++;
  return shared >= 2;
}

function fuzzyOrSkelSubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) => larger.some((lt) => fuzzyOrSkelTokenMatch(st, lt)));
}

// ── Position resolver ─────────────────────────────────────────────────────────
export function resolveWithPos(
  candidates: DbPlayer[],
  positions: FantasyPosition[],
  step: string
): MatchSuccess | MatchAmbiguous | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { kind: "match", player: candidates[0], step };
  const filtered = candidates.filter((p) => positions.includes(p.position as FantasyPosition));
  if (filtered.length === 1) return { kind: "match", player: filtered[0], step };
  if (filtered.length > 1)
    return {
      kind: "ambiguous",
      reason: `${step}: ${filtered.length} pos-filtered matches`,
      candidates: filtered.map((p) => p.name),
    };
  return { kind: "match", player: candidates[0], step };
}

// ── 7-step matcher ────────────────────────────────────────────────────────────
export function matchPlayerByName(
  rawName: string,
  positions: FantasyPosition[],
  nationPlayers: DbPlayer[]
): MatchSuccess | MatchAmbiguous | null {
  const norm = normalizeName(rawName);
  const translit = translitKey(norm);
  const tokensNorm = norm.split(/\s+/).filter(Boolean);
  const tokensTranslit = translit.split(/\s+/).filter(Boolean);

  // Step 1: Exact normalized
  {
    const cands = nationPlayers.filter((p) => normalizeName(p.name) === norm);
    const r = resolveWithPos(cands, positions, "exact-norm");
    if (r) return r;
  }

  // Step 2: Token-sorted normalized
  {
    const csvSort = [...tokensNorm].sort().join(" ");
    const cands = nationPlayers.filter((p) => {
      const dbNorm = normalizeName(p.name);
      return dbNorm.split(/\s+/).filter(Boolean).sort().join(" ") === csvSort;
    });
    const r = resolveWithPos(cands, positions, "token-sort-norm");
    if (r) return r;
  }

  // Step 3: Exact translit
  {
    const cands = nationPlayers.filter(
      (p) => translitKey(normalizeName(p.name)) === translit
    );
    const r = resolveWithPos(cands, positions, "exact-translit");
    if (r) return r;
  }

  // Step 4: Token-sorted translit
  {
    const csvSort = [...tokensTranslit].sort().join(" ");
    const cands = nationPlayers.filter((p) => {
      const dbT = translitKey(normalizeName(p.name)).split(/\s+/).filter(Boolean);
      return [...dbT].sort().join(" ") === csvSort;
    });
    const r = resolveWithPos(cands, positions, "token-sort-translit");
    if (r) return r;
  }

  // Step 5: Fuzzy subset on normalized tokens
  {
    const cands = nationPlayers.filter((p) => {
      const dbT = normalizeName(p.name).split(/\s+/).filter(Boolean);
      return fuzzySubset(tokensNorm, dbT) || fuzzySubset(dbT, tokensNorm);
    });
    const r = resolveWithPos(cands, positions, "subset-norm");
    if (r) return r;
  }

  // Step 6: Fuzzy+skeleton subset on translit tokens
  {
    const cands = nationPlayers.filter((p) => {
      const dbT = translitKey(normalizeName(p.name)).split(/\s+/).filter(Boolean);
      return fuzzyOrSkelSubset(tokensTranslit, dbT) || fuzzyOrSkelSubset(dbT, tokensTranslit);
    });
    const r = resolveWithPos(cands, positions, "subset-translit");
    if (r) return r;
  }

  // Step 7: Skeleton subset (same token count guard)
  {
    const csvSkelTokens = skeletonKey(translit).split(/\s+/).filter(Boolean);
    if (csvSkelTokens.length >= 2) {
      const cands = nationPlayers.filter((p) => {
        const dbSkelTokens = skeletonKey(translitKey(normalizeName(p.name)))
          .split(/\s+/)
          .filter(Boolean);
        if (dbSkelTokens.length !== csvSkelTokens.length) return false;
        return skelSubset(csvSkelTokens, dbSkelTokens) || skelSubset(dbSkelTokens, csvSkelTokens);
      });
      const r = resolveWithPos(cands, positions, "subset-skeleton");
      if (r) return r;
    }
  }

  return null;
}

// ── Batch helper ─────────────────────────────────────────────────────────────
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
