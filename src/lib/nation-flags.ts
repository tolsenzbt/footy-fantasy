// FIFA 3-letter code → ISO 3166-1 alpha-2 for emoji flag derivation.
// Not all FIFA codes match alpha-2; missing entries get no flag (graceful degradation).
const FIFA_TO_ISO2: Record<string, string> = {
  // CONMEBOL
  ARG: "AR", BRA: "BR", COL: "CO", URU: "UY", ECU: "EC", VEN: "VE",
  CHI: "CL", PER: "PE", BOL: "BO", PAR: "PY",
  // CONCACAF
  USA: "US", MEX: "MX", CAN: "CA", CRC: "CR", HON: "HN", SLV: "SV",
  JAM: "JM", PAN: "PA", TRI: "TT", GUA: "GT", CUB: "CU",
  // UEFA
  FRA: "FR", ESP: "ES", GER: "DE", ITA: "IT", POR: "PT", NED: "NL",
  BEL: "BE", ENG: "GB", CRO: "HR", SUI: "CH", DEN: "DK", POL: "PL",
  SWE: "SE", NOR: "NO", AUT: "AT", HUN: "HU", SRB: "RS", SVK: "SK",
  SCO: "GB", WAL: "GB", NIR: "GB", GRE: "GR", ROM: "RO", TUR: "TR",
  SVN: "SI", UKR: "UA", ALB: "AL", GEO: "GE", ISL: "IS", FIN: "FI",
  CZE: "CZ",
  // CAF
  MAR: "MA", SEN: "SN", NGA: "NG", EGY: "EG", CMR: "CM", GHA: "GH",
  CIV: "CI", RSA: "ZA", TUN: "TN", COD: "CD", DRC: "CD", MLI: "ML",
  GUI: "GN", ZAM: "ZM", ANG: "AO", BEN: "BJ",
  // AFC
  JPN: "JP", KOR: "KR", AUS: "AU", IRN: "IR", IRQ: "IQ", KSA: "SA",
  UAE: "AE", QAT: "QA", UZB: "UZ", IND: "IN", NZL: "NZ", PHI: "PH",
  BHR: "BH", JOR: "JO", OMA: "OM",
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
