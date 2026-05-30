// ─── SWITCH THESE TWO LINES WHEN UPGRADING TO THE 2026 PAID PLAN ─────────────
export const WC_LEAGUE_ID = 1;   // FIFA World Cup
export const WC_SEASON = 2026;   // switched to 2026 — paid plan active, data confirmed
// ──────────────────────────────────────────────────────────────────────────────

export const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

export async function apiFetch(
  apiKey: string,
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  const url = new URL(`${API_FOOTBALL_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": apiKey },
  });

  if (!res.ok) throw new Error(`API error ${res.status} for ${url}`);
  const data = (await res.json()) as Record<string, unknown>;

  if (
    data.errors &&
    typeof data.errors === "object" &&
    Object.keys(data.errors as object).length > 0
  ) {
    throw new Error(`API returned errors: ${JSON.stringify(data.errors)}`);
  }

  return { data, headers: res.headers };
}
