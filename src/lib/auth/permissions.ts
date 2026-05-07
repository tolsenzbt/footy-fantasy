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

export async function requireLeagueRole(
  leagueId: string,
  roles: ("commissioner" | "manager")[]
): Promise<LeagueMembership> {
  const profile = await requireAuth();

  // App admin bypasses league role checks per DESIGN.md §9
  if (profile.isAppAdmin) {
    const membership = await getLeagueMembership(leagueId);
    if (membership) return membership;

    // Admin may not have a membership row — synthesise one so callers always
    // get a LeagueMembership back.
    return {
      id: "admin-bypass",
      leagueId,
      userId: profile.id,
      role: "commissioner",
      displayName: profile.displayName,
      eliminatedAtRound: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const membership = await getLeagueMembership(leagueId);

  if (!membership || !roles.includes(membership.role)) {
    redirect("/login");
  }

  return membership;
}
