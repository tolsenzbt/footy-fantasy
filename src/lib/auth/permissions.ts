import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { leagueMemberships } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

export type Profile = InferSelectModel<typeof profiles>;
export type LeagueMembership = InferSelectModel<typeof leagueMemberships>;

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  return profile ?? null;
}

export async function requireAuth(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  return profile;
}

export async function requireAppAdmin(): Promise<Profile> {
  const profile = await requireAuth();
  if (!profile.isAppAdmin) redirect("/login");
  return profile;
}

export async function getLeagueMembership(
  leagueId: string
): Promise<LeagueMembership | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const [membership] = await db
    .select()
    .from(leagueMemberships)
    .where(
      and(
        eq(leagueMemberships.leagueId, leagueId),
        eq(leagueMemberships.userId, profile.id)
      )
    )
    .limit(1);

  return membership ?? null;
}

/**
 * Permission check for league-scoped actions. Throws (redirects) on failure;
 * returns void on success.
 *
 * App admins (profiles.is_app_admin = true) always pass, regardless of
 * whether they have a league_memberships row in this league.
 *
 * NOTE: This is permission-only. It does NOT return a LeagueMembership row.
 * Callers that need to write a manager-attributed action to a per-league table
 * (where manager_id FKs league_memberships.id) must separately call
 * getLeagueMembership and handle the case where an app admin without a real
 * membership row attempts a manager action. In that case the action should
 * fail — the admin can correct DB state directly via Supabase dashboard per
 * DESIGN.md §13.
 *
 * Typical usage:
 *   await requireLeagueAccess(leagueId, ['commissioner', 'manager']);
 *   const membership = await getLeagueMembership(leagueId);
 *   if (!membership) throw new Error('No membership row for this league');
 *   // safe to use membership.id as a FK
 */
export async function requireLeagueAccess(
  leagueId: string,
  roles: ("commissioner" | "manager")[]
): Promise<void> {
  const profile = await requireAuth();

  // App admin bypasses league role checks per DESIGN.md §9.
  if (profile.isAppAdmin) return;

  const membership = await getLeagueMembership(leagueId);

  if (!membership || !roles.includes(membership.role)) {
    redirect("/login");
  }
}
