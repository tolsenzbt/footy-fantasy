import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { runIngestSweep } from "@/lib/stats/ingest";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API_FOOTBALL_KEY not configured" }, { status: 500 });
  }

  try {
    const result = await runIngestSweep(apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Ingest sweep error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
