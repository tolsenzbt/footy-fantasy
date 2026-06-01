import "server-only";
import { db } from "@/db";
import { drafts, draftOrder, leagues } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveDraftPosition, leagueSizeFromFormat } from "./snake";
import type { InferSelectModel } from "drizzle-orm";

type DraftRow = InferSelectModel<typeof drafts>;

export type DraftState = {
  draft: DraftRow;
  expiresAt: Date | null;
  isExpired: boolean;
  onTheClockManagerId: string | null;
};

export async function getDraftState(
  leagueId: string,
  draftType: "initial" | "redraft"
): Promise<DraftState> {
  const now = new Date();

  // Lazy pending→active transition
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, draftType)))
      .for("update")
      .limit(1);

    if (!row) throw new Error(`No ${draftType} draft found for league ${leagueId}`);

    if (
      row.status === "pending" &&
      row.startsAt !== null &&
      row.startsAt <= now
    ) {
      await tx
        .update(drafts)
        .set({
          status: "active",
          startedAt: row.startsAt,
          currentPickNumber: 1,
          currentPickStartedAt: row.startsAt,
          updatedAt: now,
        })
        .where(eq(drafts.id, row.id));
    }
  });

  // Re-fetch outside the transaction to get consistent post-transition state
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, draftType)))
    .limit(1);

  if (!draft) throw new Error(`No ${draftType} draft found for league ${leagueId}`);

  if (draft.status !== "active") {
    return { draft, expiresAt: null, isExpired: false, onTheClockManagerId: null };
  }

  // Compute expiry
  const expiresAt = draft.currentPickStartedAt
    ? new Date(draft.currentPickStartedAt.getTime() + draft.pickClockSeconds * 1000)
    : null;
  const isExpired = expiresAt !== null && now > expiresAt;

  // Look up which manager is on the clock
  let onTheClockManagerId: string | null = null;

  if (draft.currentPickNumber !== null) {
    const [league] = await db
      .select({ format: leagues.format })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);

    if (!league) throw new Error(`League ${leagueId} not found`);

    const leagueSize = leagueSizeFromFormat(league.format);
    const position = resolveDraftPosition(draft.currentPickNumber, leagueSize, 14);

    const [orderRow] = await db
      .select({ managerId: draftOrder.managerId })
      .from(draftOrder)
      .where(
        and(
          eq(draftOrder.draftId, draft.id),
          eq(draftOrder.position, position)
        )
      )
      .limit(1);

    onTheClockManagerId = orderRow?.managerId ?? null;
  }

  return { draft, expiresAt, isExpired, onTheClockManagerId };
}
