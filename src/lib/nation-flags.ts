// FIFA code → ISO 3166-1 alpha-2 for emoji flag derivation.
// Keys are the actual fifa_code values stored in the nations table (sourced from
// Wikipedia WC2026 squad lists). Two DB collisions exist and are intentionally
// omitted: AUS (Australia AND Austria share the same code), IRA (Iraq AND Iran).
// Those nations will render flag-less until the DB collision is resolved (§16).
const FIFA_TO_ISO2: Record<string, string> = {
  // CONMEBOL
  ARG: "AR", BRA: "BR", COL: "CO", URU: "UY", ECU: "EC", VEN: "VE",
  CHI: "CL", PER: "PE", BOL: "BO", PAR: "PY",
  // CONCACAF
  USA: "US", MEX: "MX", CAN: "CA", CRC: "CR", HON: "HN", SLV: "SV",
  JAM: "JM", PAN: "PA", TRI: "TT", GUA: "GT", CUB: "CU",
  HAI: "HT",
  // UEFA
  FRA: "FR", SPA: "ES", GER: "DE", ITA: "IT", POR: "PT", NET: "NL",
  BEL: "BE", ENG: "GB", CRO: "HR", SWI: "CH", DEN: "DK", POL: "PL",
  SWE: "SE", NOR: "NO", HUN: "HU", SRB: "RS", SVK: "SK",
  SCO: "GB", WAL: "GB", NIR: "GB", GRE: "GR", ROM: "RO", TUR: "TR",
  SVN: "SI", UKR: "UA", ALB: "AL", GEO: "GE", ISL: "IS", FIN: "FI",
  CZE: "CZ", BOS: "BA",
  // CAF
  MOR: "MA", SEN: "SN", NGA: "NG", EGY: "EG", CMR: "CM", GHA: "GH",
  IVO: "CI", SOU: "ZA", TUN: "TN", CON: "CD", MLI: "ML",
  GUI: "GN", ZAM: "ZM", ANG: "AO", BEN: "BJ", ALG: "DZ", CAP: "CV",
  // AFC
  JAP: "JP", KOR: "KR", JOR: "JO", SAU: "SA",
  UAE: "AE", QAT: "QA", UZB: "UZ", IND: "IN", ZEA: "NZ", PHI: "PH",
  BHR: "BH", OMA: "OM", CUR: "CW",
};

export function fifaToIso2(fifaCode: string): string | null {
  return FIFA_TO_ISO2[fifaCode.toUpperCase()] ?? null;
}

export function iso2ToFlagEmoji(iso2: string): string {
  // Regional indicator offset: 'A'.charCodeAt(0) = 65; 🇦 = U+1F1E6 = 127462; offset = 127397
  return iso2.toUpperCase().split("").map(
    (ch) => String.fromCodePoint(ch.charCodeAt(0) + 127397)
  ).join("");
}

export function fifaToFlagEmoji(fifaCode: string): string | null {
  const iso2 = fifaToIso2(fifaCode);
  return iso2 ? iso2ToFlagEmoji(iso2) : null;
}
