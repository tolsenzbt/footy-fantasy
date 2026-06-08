# Footy Fantasy — Design Document

**Project:** A fantasy soccer app for the 2026 FIFA World Cup, built for a private league of 8, 12, or 16 friends.

**Status:** In active implementation. Backend/logic complete and end-to-end validated (see §16). Player pool rebuilt from official 2026 WC squads (§10). All UI remains. All format and architectural decisions in this document are locked unless explicitly revisited.

**Last updated:** June 8, 2026 (v8 — player pool rebuilt from official Wikipedia WC squads as the authoritative spine, replacing the API-Football squad-endpoint seed; `api_football_id` made nullable with backfill deferred to post-kickoff (§10); `real_position` dropped and `fantasy_position` column renamed to `position`; `player_rankings` table + `play_status` enum added for the draft cheat sheet (§10, new subsection); validation league + all seed data wiped for production reset (§16); migration 0011. v6 — deployment live: §9 Resend SMTP + custom domain `footyfantasy.app`. v5 — stats ingestion + live scoring phase: §6/§10/§11/§16.); player_projections table + O-Rank ingest pipeline built (§10); migration 0012

---

## 1. Project Overview

Footy Fantasy is a private fantasy soccer league for the 2026 World Cup, designed for one league administrator and 7, 11, or 15 friends. The app handles drafting, lineup setting, automated scoring, head-to-head matchups, and a knockout playoff bracket that mirrors the real-world tournament.

**Goals:**
- Ship a working MVP before the World Cup begins on June 11, 2026
- Keep operating costs at or near $0
- Produce a polished experience that feels modern on both desktop and mobile browsers
- Support flexible league sizes so the league can launch even if recruiting falls short of 16

**Non-goals:**
- Public leagues
- Native mobile apps (responsive web only)
- Monetization
- Trading mechanics (managers can swap via free agency on an honor system if desired)

---

## 2. Tournament Structure

### Real-world reference
- 48 teams, 12 groups of 4
- Group stage: June 11–27, 2026
- Round of 32 begins immediately after group stage
- Tournament concludes July 19, 2026

### Fantasy round identifiers
The schema and this document use the following round identifiers throughout:

| Fantasy round identifier | Real-world round it scores from |
|---|---|
| `group_md1` | Group stage matchday 1 |
| `group_md2` | Group stage matchday 2 |
| `group_md3` | Group stage matchday 3 |
| `qf` (fantasy quarterfinals) | Round of 32 |
| `sf` (fantasy semifinals) | Round of 16 |
| `final` (fantasy final) | Quarterfinals |

The fantasy season ends when 8 real teams are still alive. Real-world Semifinals, 3rd-place match, and Final occur after the fantasy champion is crowned.

### Supported league sizes
The app supports three league formats: **8, 12, or 16 managers.** Format is selected by the admin and locked at draft start.

### Group-stage tiebreakers (all formats, in order)
Standings rank is **Points For first**, not wins-first — the W/L/D record is displayed but PF is the primary sort key. The chain, applied within each group:
1. Total fantasy points scored across all matchups (Points For), descending
2. Head-to-head result between tied managers:
   - **2-way tie:** the result of the single matchup between them (a draw in that matchup falls through to step 3).
   - **3+-way tie:** a mini-table of only the games played among the tied managers, ranked by W/L/D record in those games. If it fully separates them, done. If it partially separates (a subset remains tied), the full chain is re-run from step 1 on that still-tied subset. A subset that remains tied after the mini-table (e.g. a circular A>B>C>A result) falls through to step 3.
3. Highest single-matchday score (the manager's own highest single-round fantasy total across the three matchdays), descending
4. Random — a per-manager `group_standings.random_tiebreak` value, assigned once at first standings computation and reused on every recompute so ties never reshuffle across recomputes.

---

## 3. Format Specifications

### Important terminology: schedule slots vs. group standings

The format spec uses identifiers like `A1`, `B2`, etc. in two distinct contexts. These must NOT be confused:

**Schedule slot** (e.g., `A1`, `A2`, `B1`): assigned during the live group draw event. Static for the entire group stage. Determines who you play and when. Has no relationship to skill or final standing — `A1` just means "the first manager randomly drawn into Group A."

**Group standing** (e.g., `1A`, `2B`): computed after `group_md3` based on record, PF, tiebreakers. Dynamic — represents your final position within your group. `1A` means "the 1st-place finisher of Group A," who may or may not be the manager who held schedule slot `A1`.

**Schedule slots are used in:** the pre-locked group-stage schedule (Section 3), the group draw event (Section 4).

**Group standings are used in:** the knockout bracket (Section 3 brackets), the redraft order (Section 7).

The schema must track these as separate concepts.

---

### 16-team format

**Group stage:** 4 fantasy groups of 4 managers (A, B, C, D). Each manager plays a round-robin within their group across `group_md1`, `group_md2`, `group_md3`.

**Schedule (using slot identifiers, locked pre-tournament):**
- `group_md1`: A1-A2, A3-A4, B1-B2, B3-B4, C1-C2, C3-C4, D1-D2, D3-D4
- `group_md2`: A1-A3, A2-A4, B1-B3, B2-B4, C1-C3, C2-C4, D1-D3, D2-D4
- `group_md3`: A1-A4, A2-A3, B1-B4, B2-B3, C1-C4, C2-C3, D1-D4, D2-D3

**Knockout qualification:** Top 2 from each group → 8 advance.

**Bracket (cross-group, mirrors real WC) — uses group standings, not schedule slots:**
- Top half: 1A vs 2B, 1B vs 2A
- Bottom half: 1C vs 2D, 1D vs 2C
- Winners advance through `sf` to `final`.

(`1A` = 1st-place finisher of Group A, `2B` = 2nd-place finisher of Group B, etc.)

### 12-team format

**Group stage:** 4 fantasy groups of 3 managers (A, B, C, D). Each manager plays both group-mates AND one cross-group opponent over `group_md1`, `group_md2`, `group_md3`.

**Schedule (locked pre-tournament):**
- `group_md1`: A1-A2, B1-B2, C1-C2, D1-D2, A3-B3, C3-D3
- `group_md2`: A1-A3, B1-B3, C1-C3, D1-D3, A2-B2, C2-D2
- `group_md3`: A2-A3, B2-B3, C2-C3, D2-D3, A1-B1, C1-D1

**Cross-group pairing structure:** A↔B and C↔D groups are paired, with same-position-slot managers facing each other on their cross-group matchday.

**Cross-group match counts toward standings.** Every manager plays exactly 3 matches; all 3 count toward group W/L/D/PF, including the one cross-group match. The cross-group pairing is purely the mechanism for generating a third matchup in a 3-manager group — it carries the same standings weight as the two in-group matches. Standings computation applies no in-group/cross-group filtering.

**Knockout qualification:** Top 2 from each group → 8 advance.

**Bracket:** Same as 16-team format (1A vs 2B, etc.).

### 8-team format

**Group stage:** 2 fantasy groups of 4 managers (A, B). Each manager plays a round-robin within their group across `group_md1`, `group_md2`, `group_md3`.

**Schedule (locked pre-tournament):**
- `group_md1`: A1-A2, A3-A4, B1-B2, B3-B4
- `group_md2`: A1-A3, A2-A4, B1-B3, B2-B4
- `group_md3`: A1-A4, A2-A3, B1-B4, B2-B3

**Knockout qualification:** Top 3 from each group → 6 advance.

**Bracket structure (uses group standings, not schedule slots):**
- 1A and 1B receive first-round byes, represented as concrete `qf` matchups against a BYE (see "Bye representation" below), not as absence from the round
- `qf`: 2A vs 3B, 2B vs 3A, 1A vs BYE, 1B vs BYE
- `sf`: (1A/BYE winner) vs (2A/3B winner), (1B/BYE winner) vs (2B/3A winner)
- `final`: `sf` winners

The bye matchups auto-resolve in favor of 1A/1B at seed resolution (no scores needed); the effect is identical to a first-round bye — 1A/1B advance to `sf` — but every advancing manager occupies a `qf` row so the bracket has one uniform shape across rounds.

(`1A` = 1st-place finisher of Group A, etc.)

### Bye representation (8-team only)

In the 8-team format, 1A and 1B receive first-round byes. These are stored in `fantasy_matchups` as concrete rows with `away_seed_source='BYE'`, `away_manager_id=null`, `away_score=null`. The matchup auto-resolves in favor of the home (real) participant regardless of their score. The reserved string `'BYE'` is the sentinel for this case.

---

## 4. Group Draw Event

After the initial draft completes, a **live group drawing event** assigns managers to slot identifiers (A1, A2, B1, etc.) randomly.

### Mechanics
- Admin schedules the event for a specific time
- Managers can join the page to watch live
- Draws are revealed one slot at a time on a timer (e.g., 5-second intervals)
- Fill order (breadth-first by slot position):
  - **8-team:** A1 → B1 → A2 → B2 → A3 → B3 → A4 → B4
  - **12-team:** A1 → B1 → C1 → D1 → A2 → B2 → C2 → D2 → A3 → B3 → C3 → D3
  - **16-team:** A1 → B1 → C1 → D1 → A2 → B2 → C2 → D2 → A3 → B3 → C3 → D3 → A4 → B4 → C4 → D4

### Admin override
The admin can manually enter group assignments instead of using the in-app drawing (for cases where the draw is done IRL with ping pong balls, etc.). Handled via DB for MVP.

### Schedule generation
Because all matchup schedules are pre-locked using slot identifiers, the schedule is automatically determined the moment slot assignments complete.

---

## 5. Roster & Lineups (all formats)

### Roster size
**14 players total**, with the following position constraints:

| Position | Min | Max |
|---|---|---|
| Goalkeeper | 1 | 2 |
| Defender | 3 | 5 |
| Midfielder | 3 | 5 |
| Forward | 1 | 3 |

Total must equal exactly 14, AND each position must fall within its range.

### Starting XI (must total 11)
1 GK + 10 outfield, in a valid formation:
- **3-4-3, 3-5-2**
- **4-3-3, 4-4-2, 4-5-1**
- **5-3-2, 5-4-1**

### Captain & Vice-Captain
- One starter is designated **Captain** each matchday → scores 2x
- One starter is designated **Vice-Captain** → auto-promotes to 2x if Captain plays 0 minutes
- Both must be selected from the starting XI
- VC is optional — if no VC is set and the captain plays 0 minutes, the captain simply scores 1x with no fallback

### Lineup lock
- A player is **locked** the moment their nation's match kicks off
- Locked players cannot be moved out of the starting XI for that match
- - Captain selection locks when the captained player's nation kicks off, independently of VC. VC selection locks when the VC'd player's nation kicks off. Before lock, captain/VC may be reassigned to any non-locked starter.
- Other players (whose nations haven't kicked off yet) remain freely movable

### Auto-rollover
- After the initial draft, all players begin on the bench. Managers must set their initial lineup.
- Once set, lineups persist matchday-to-matchday until the manager changes them
- Admin can manually adjust lineups in edge cases

### No nation cap
There is no limit on how many players a manager can roster from a single nation.

---

## 6. Scoring System

Scoring follows standard FPL conventions. No bonus points system (BPS).

| Action | GK | DEF | MID | FWD |
|---|---|---|---|---|
| Played 1–59 minutes | 1 | 1 | 1 | 1 |
| Played 60+ minutes | 2 | 2 | 2 | 2 |
| Goal scored | 10 | 6 | 5 | 4 |
| Assist | 3 | 3 | 3 | 3 |
| Clean sheet (60+ min played) | 4 | 4 | 1 | 0 |
| Every 3 saves (GK only) | 1 | — | — | — |
| Penalty saved (GK only) | 5 | — | — | — |
| Penalty missed | -2 | -2 | -2 | -2 |
| Every 2 goals conceded | -1 | -1 | 0 | 0 |
| Yellow card | -1 | -1 | -1 | -1 |
| Red card (also voids clean sheet) | -3 | -3 | -3 | -3 |
| Own goal | -2 | -2 | -2 | -2 |

**Captain multiplier:** 2x all of the above for the captained player.

### Scoring clarifications

These resolve rule-level ambiguities the scoring table alone doesn't cover:

- **Goals conceded are counted while-on-pitch only.** A player is charged the −1-per-2-conceded penalty only for goals their team concedes during the minutes they were on the field. Goals conceded after a player is substituted off (or sent off) do not count against them.
- **Clean sheet is derived, not provided.** A player earns the clean-sheet bonus if they played 60+ minutes AND conceded 0 goals while on the pitch. A player subbed off before the 60th minute is ineligible regardless of the eventual result; a player subbed off at 60+ with 0 conceded to that point keeps the clean sheet even if their team concedes later.
- **Red card voids the clean sheet but NOT appearance points.** A sent-off player still earns appearance points (1 or 2) for minutes played; the −3 and the clean-sheet void are independent of those points.

The scoring engine is a pure function. It takes `minutesPlayed` and `concededWhileOnPitch` as numeric inputs and derives clean-sheet eligibility and the goals-conceded penalty itself — it does NOT accept a precomputed clean-sheet boolean or whole-match conceded total. Computing `concededWhileOnPitch` from match events and substitution data is the responsibility of the (separate, later) stats-ingestion layer.

### Stats storage model

`player_match_stats` is the raw per-player match record. It stores three
conceded/clean-sheet-related fields with distinct roles:

- `conceded_while_on_pitch` (integer) — derived by the ingestion layer from match
  events + substitution timing. This is the ONLY one of the three the §6 scoring
  engine consumes. Stored (not computed transiently) so every persisted
  `player_match_scores.points` value is auditable against its exact input, and so an
  admin can correct a bad stat directly in the DB (§13) and re-trigger recompute.
- `goals_conceded` (integer) — raw whole-match team-conceded figure as reported by
  the API. NOT a scoring input. Retained for display and debugging.
- `clean_sheet` (boolean) — clean sheet as reported by the API. NOT a scoring input;
  the engine derives clean-sheet eligibility itself from `minutesPlayed`,
  `concededWhileOnPitch`, and red-card state. Retained so a derivation discrepancy
  (API says clean sheet, engine derives otherwise) is visible at a glance when
  debugging.

The ingestion layer computes per-player base points by calling the pure `scorePlayer`
engine once per player and writing the result to `player_match_scores.points`.
Lineup-level assembly (captain/VC multiplier, starting-XI summation) happens
downstream at read/resolve time from stored base points — never from raw stats.

### Deriving `concededWhileOnPitch` from API-Football events

`conceded_while_on_pitch` is computed by the ingestion layer from two API-Football
endpoints per fixture: `/fixtures/events` (goals, substitutions, cards with minutes)
and `/fixtures/players` (per-player minutes and starter/sub flag). It is NOT provided
directly by the API. The algorithm runs identically on a finished match or a match in
progress (partial events) — mid-match, a player's on-pitch interval may simply still be
open.

**Per-player on-pitch interval `[onMin, offMin)`:**
- `onMin` = 0 if the player started (`players[].statistics[0].games.substitute === false`),
  else the minute they entered (the `subst` event where their player ID is the `assist`).
- `offMin` = the earliest of: the minute they came off (the `subst` event where their
  player ID is the `player`), a red-card minute for them, or +∞ (played to the whistle /
  still on mid-match).

  API-Football substitution convention: in a `subst` event, `player` is coming OFF and
  `assist` is coming ON.

**Effective goal minute:** `time.elapsed + (time.extra ?? 0)`.

**Conceding-team rule (uniform across goal types):** for any `type === "Goal"` event, the
conceding team is the team that is NOT `event.team.id`.
- Normal / Penalty: `event.team.id` is the scorer's team → the other team concedes.
- Own Goal (`detail === "Own Goal"`): API reports `event.team.id` as the *beneficiary* and
  `event.player.id` as the scorer (on the conceding team). Since `event.team.id` is the
  beneficiary, "not `event.team.id`" is still the conceding team — same rule, no special
  case. (Confirmed against 2022 fixture 855767: Aguerd, a Morocco player, OG credited to
  Canada; `event.team.id` = Canada, conceding team = Morocco.)

**VAR-cancelled goals:** `type === "Var"` events (e.g. `"Goal cancelled"`) are not goals
and never count. Only `type === "Goal"` counts.

**Computation:** for each player, `concededWhileOnPitch` = count of Goal events whose
conceding team is the player's nation AND whose effective minute G satisfies
`onMin <= G < offMin`.

**Validation guard:** the ingestion layer cross-checks derived on-pitch duration against
the API's reported `games.minutes`; a discrepancy beyond a few minutes (stoppage slack) is
logged as a warning, usually indicating a missed substitution event.

The own-goal scoring penalty (−2 to the scorer) is a separate stat (`own_goals`, keyed off
`event.player.id` + `detail === "Own Goal"`) and is unrelated to the conceding-team rule.

---

## 7. Drafts

### Initial Draft (all formats)
- **Format:** Snake
- **Rounds:** 14 (one per roster slot)
- **Pick clock:** ~8 hours per pick (allows async over multiple days)
- **Order determination:** Random, generated by app, with **admin override capability**
- **Total picks:** 14 × N (where N = league size)

### Supplemental Redraft (all formats)
Held the morning of the real-world Round of 32.

- **Participants:**
  - 16-team format: 8 advancing managers
  - 12-team format: 8 advancing managers
  - 8-team format: 6 advancing managers
- **Order (by-need):** count of auto-dropped eliminated-nation players (descending); tiebreaker 1 = group-stage points (descending); tiebreaker 2 = highest single-matchday score (descending). Computed once at redraft start and fixed for the duration (opt-outs and skips do not reorder it). The auto-dropped count per manager derives from mass-release drops (`waiver_player_status.drop_reason = 'mass_release'`, grouped by `dropped_by_manager_id`).
- **Format:** Snake
- **Rounds:** 10 maximum, regardless of league size
- **Pick clock:** 60 seconds per pick (rapid-fire)
- **Pick action:** Within the 60s window the manager selects a player to add, then (only if at 14 players) selects a player to drop. Not dropping is valid only when the manager has an open roster spot.
- **Timeout (auto-pick):** If the clock expires AND the manager has an open roster spot, the system auto-picks the **best available** player — filtered to positions that are legal to add given the manager's current roster (§5 maxes), then highest group-stage points among that filtered pool. Auto-pick never drops a player to make room. If the manager has no open spot at timeout, the pick is **skipped** (no auto-drop). A timeout (auto-pick or skip) is NOT an opt-out — the manager remains active for later rounds.
- **Opt-out ("done"):** A manager may permanently opt out at any time via an explicit "done" action (UI: checkbox + "Are you sure? You will no longer be able to make picks" confirmation). Once confirmed they are removed from all future pick generation but retain read/watch access. This is the only terminal exit. The redraft ends when every participant has opted out or the 10-round cap is reached.
- **Full-roster picks:** If a manager is at 14 players when picking, they must drop a player on the same turn (see Pick action). The dropped player goes to waivers and is not re-selectable in this redraft (§8, frozen pool).
- **Available pool:** Frozen at redraft start. Includes pre-existing free agents and players on waivers because their nation was eliminated / mass-released. Excludes players on waivers because a manager dropped them (`drop_reason = 'manager_drop'`). Eliminated managers' rosters are locked and never available.

---

## 8. Waivers & Free Agency

### Core principle
No live free agency during matches. All player movement is committed before kickoff and processed at scheduled times.

### Waiver priority
- **Group stage:** Initial order is reverse of initial draft order. Successful claims send claimant to bottom; others shift up. Failed claims do not affect priority. Priority persists through entire group stage.
- **Knockouts:** Priority resets immediately after the redraft completes. New order = **reverse of the start-of-redraft by-need order** (§7), over participating (advancing) managers only; eliminated managers are removed. Managers who opted out ("done") during the redraft retain their priority slot — opting out does not reorder priority.

### Group-stage → knockout transition sequence

The transition is a fixed ordering with timing dependencies. Each step depends on the prior:

1. **Mass-release batch** — runs in the final group-stage waiver cron, after normal claim resolution (§ mass-release above). Produces the per-manager auto-dropped count.
2. **Redraft** — admin action (`group_stage→redrafting`). By-need order computed from step 1. Pool frozen at start. Runs snake, picks consume the pool live.
3. **Redraft completes** — admin action (`redrafting→knockouts`). Completion timestamp recorded.
4. **Priority reset** — fires immediately on completion (reverse of start-of-redraft by-need order, eliminated removed). Must precede step 5.
5. **First knockout waiver processing event** — fires at redraft completion **+1 hour**. This is a **full waiver processing pass**, not a straight clear: all claims over every waivered player are resolved using the reset priority from step 4; any player unclaimed after resolution becomes a free agent (FCFS). This replaces the earlier "unselected players clear waivers 1h after redraft" framing — there is no separate clear mechanism; the +1h event is simply the first knockout processing event, scheduled early.
6. **Subsequent knockout waiver events** — normal 5am ET cron, one per real-world knockout round.

### Multiple claims per event
A manager may win more than one player in a single processing event. After a successful claim drops the manager to the bottom of priority, they remain eligible for further awards on subsequent resolver passes as long as they have open roster spots and remaining ranked claims. Players continue to fall to a manager at lowest priority if no higher-priority manager claims them.

### Waiver triggers
A player enters waivers when:
1. **Their nation kicks off a match** (rostered or not — they're locked from changes during the match)
2. **A manager drops them** (24-hour window minimum)

### Waiver processing schedule
- One processing event per real-world matchday at **5am ET** the morning after the matchday's last game
- Group stage: 3 processing events (after `group_md1`, `group_md2`, `group_md3`)
- Knockouts: 1 processing event after each round
- Special: post-redraft waivers clear 1 hour after redraft completes

### Waiver exit conditions
- **Successful claim:** Player goes to highest-priority claimant
- **Cleared with no claims AND nation hasn't kicked off next match:** Player becomes a free agent (FCFS pickup)
- **Cleared with no claims AND nation already played:** Player re-enters waivers for next round

### Waiver extension rule
If a player is on waivers and their nation kicks off their next match before waivers are processed, the waiver is extended to the next round's 5am processing window.

### Drop window
A dropped player sits on waivers for 24 hours minimum, then follows standard processing rules.

### Conditional drops
Waiver claims can include a "drop-if-successful" designation. A conditional drop may only target a player on the claimant's own roster. A manager's claims are ranked; the resolver takes their highest-ranked claim that is still available and fits an open roster spot (opening one via the conditional drop if specified). Once a claim succeeds, the manager's lower-ranked claims sharing that drop player are dead by roster-space — this is what "auto-void" means. There is no cross-manager auto-void.

### Initial draft aftermath
All undrafted players sit on waivers for 24 hours after the draft concludes, then become free agents.

### Mass release at end of group stage
- All players from non-advancing nations on **advancing managers' rosters** are auto-dropped at conclusion of `group_md3`. This auto-drop runs as a **second phase of the final group-stage waiver cron** (the 5am ET event after `group_md3`'s last game), after normal claim resolution completes — NOT on the admin `group_stage→redrafting` transition. The admin transition is a pure read of already-settled state. The auto-dropped count per manager is the input to the redraft's by-need ordering (§7), so it must be finalized before the redraft starts.
- These players sit on waivers through the redraft and form the selectable redraft pool (§7), alongside pre-existing free agents.
- Players selected in the redraft come off waivers.
- The redraft pool is **frozen at redraft start**. Players dropped during the redraft (full-roster drops) and any players manually dropped by managers whose 24h window overlaps the redraft go to waivers normally and are **NOT re-selectable within the same redraft** — this prevents drop-and-reclaim roster laundering. They are resolved at the first knockout waiver processing event (below), not during the redraft.

Auto-drop applies only to advancing managers' rosters. Non-advancing (eliminated) managers' rosters are locked intact at end of group stage; their players (whether from advancing or eliminated nations) are not returned to the pool.

### Eliminated managers
Rosters lock at end of group stage. Players on eliminated managers' rosters are removed from the active pool entirely (regardless of whether their nation is still alive in the real tournament).

---

## 9. Authentication & League Management

- **Auth model:** Email-based, magic link only via Supabase Auth (`@supabase/ssr`). Password and social login intentionally out of scope for MVP; either can be added later without architectural changes.
- **Session lifetime:** Supabase defaults — 1-hour access token auto-refreshed via cookie middleware, 60-day refresh token. Users stay logged in indefinitely on a given device as long as they visit at least once every 60 days.
- **User creation:** Admin creates accounts via `supabase.auth.admin.createUser()` (server action, service role). No public registration UI.
- **Profile mirroring:** A Postgres trigger (`on_auth_user_created`) on `auth.users` insert creates the corresponding `public.profiles` row atomically. `display_name` defaults to the email prefix; admin/user can update later.
- **Admin bootstrap:** First admin self-signs up via the magic link flow, then is promoted via a one-time SQL update (`update public.profiles set is_app_admin = true where email = '...'`). Documented in `docs/setup.md`. **Done** — bootstrap admin account is live and promoted against the deployed DB; the `on_auth_user_created` trigger is confirmed firing in production (profile row auto-created on first login).
- **No social login** (Google/Apple OAuth out of scope for MVP — adding Google later is ~30 minutes of work)
- **No public registration**
- **Email delivery (SMTP):** A custom SMTP provider is **required before managers can log in** — Supabase's built-in default SMTP is best-effort only (no delivery SLA), capped at 2 emails/hour, and only delivers to the project's own org-member addresses, so magic links to league members would silently fail. **Resend** is the configured provider (free tier, 3,000/mo), connected to Supabase via Resend's Supabase integration (Resend-side, not Supabase-side), which provisions the API key and writes Supabase's SMTP settings automatically. Sender: `noreply@footyfantasy.app`. After connecting, the auth email rate limit defaults to 25/hour; raised in Authentication → Rate Limits. SPF/DKIM/DMARC records auto-added in Cloudflare DNS via Resend's Cloudflare integration.

### Roles
The system distinguishes three roles, stored in two distinct places:

- **Admin (app-level):** Flagged via `profiles.is_app_admin` (boolean). Not associated with any specific league. Can create leagues, manage user accounts across leagues, perform out-of-app database operations, and exercise all in-league powers in any league. The project owner holds this role. The admin joins leagues as a manager under a separate user account to participate as a regular player.
- **Commissioner (league-scoped):** Stored as `league_memberships.role = 'commissioner'`. Reserved for future use — defined in the schema and permission model but not assigned for the inaugural league. Will allow per-league self-management (in-app UI for waiver overrides, lineup resets, etc.) without admin involvement.
- **Manager (league-scoped):** Stored as `league_memberships.role = 'manager'`. A league participant: drafts a team, sets lineups, makes waiver claims.

The `membership_role` enum contains exactly `commissioner` and `manager`. App-level admin is deliberately not a membership role — it's a separate axis of authority orthogonal to league participation.

### Permission helpers
Server-only helpers in `src/lib/auth/permissions.ts`:

- `getCurrentProfile()` — returns the current user's profile or null
- `requireAuth()` — throws redirect to `/login` if not authed
- `requireAppAdmin()` — throws if not `is_app_admin`
- `getLeagueMembership(leagueId)` — returns the membership row or null
- `requireLeagueAccess(leagueId, roles[])` — permission check only, returns void; app admins always pass

`requireLeagueAccess` is intentionally split from `getLeagueMembership` because they answer different questions ("is this person allowed?" vs. "what membership row represents them?"). Per-league tables (lineups, draft_picks, etc.) FK to `league_memberships.id`, so callers writing manager-attributed actions must check both: app admins acting in a league they're not a member of cannot perform manager actions through the app; admin handles that case via direct DB operations per §13.

### RLS strategy (MVP)
All 24 public tables have RLS enabled with `service_role_full_access` policies only. No authenticated-role policies. All mutations flow through server actions running with the service role key; gating happens at the application layer via the permission helpers above. Rationale: for a 16-person private app where the same author owns the schema and the server code, RLS as a second defense layer adds policy-vs-code drift risk without proportional security benefit. Revisit only if the app ever opens to less-trusted clients.

### League lock
The following are determined and frozen when the admin clicks "Start Draft":
- League size (8, 12, or 16) — cannot change after this
- Manager list — no adds/drops to the league after this
- Initial draft order — generated (random) or admin-set
- Match schedule — automatically derived from league size

The following are determined at the group draw event:
- Slot assignments (A1, B2, etc.)
- Group memberships (derived from slot)

### League status state machine

`leagues.status` is a coarse phase indicator. Transitions happen at explicit admin actions, not as side effects of other operations:

| From | To | Trigger |
|---|---|---|
| `setup` | `drafting` | Admin starts the draft (start-draft.ts) |
| `drafting` | `group_stage` | Admin runs the group draw and confirms |
| `group_stage` | `redrafting` | Admin starts the redraft |
| `redrafting` | `knockouts` | Admin completes the redraft |
| `knockouts` | `complete` | Admin marks tournament complete (or auto, after final fantasy round) |

Sub-phase progress (draft picks complete? group draw run? group stage matchdays played?) is derived from related tables (`drafts.status`, `schedule_slots`, `group_standings`, `fantasy_matchups`), not from `leagues.status`.

Note: the `group_stage→redrafting` transition does **not** trigger the mass-release batch. Mass-release runs earlier, in the final group-stage waiver cron (§8). By the time the admin starts the redraft, auto-drops are already settled and the by-need count is queryable. The transition is a pure read of that state.

---

## 10. Stats & Data Source

### Primary source
**API-Football** (api-football.com), paid plan (active)
- 7,500 requests/day
- 450 requests/minute rate limit
- All endpoints available
- Returns full match player stats in a single call per fixture

### Player pool source
The player pool (`players` table) is sourced from the **official 2026 WC squad lists on Wikipedia**, not from API-Football's squad endpoint. Rationale: API-Football's `/players/squads` returns each nation's general player pool (often 30–49 names), not the final 26-man tournament squad, and pre-tournament its competition-scoped player endpoints (`/players?league=1&season=2026`) return nothing — `coverage.players` is `false` until matches begin. The official squads are factual public-record data; Wikipedia's per-nation squad tables are the authoritative, structured source.

A frozen snapshot (`data/wc-squads-2026.json`, 48 nations, 1,243 players) drives the pool. Each `players` row carries `name` (full, diacritics preserved), `nation_id`, and `position` (the single position field, sourced from the wiki squad-list classification GK/DF/MF/FW → GK/DEF/MID/FWD). There is one position column; an earlier `real_position`/`fantasy_position` split was collapsed (migration 0011).

`players.api_football_id` is **nullable and currently all-null**. It is the join key for stats ingestion but is NOT required for drafting, rosters, waivers, or matchups (those key on the internal `players.id` UUID). The backfill is **deferred to post-kickoff**: once `coverage.players` flips true (~June 11), the paginated `/players?league=1&season=2026` endpoint returns the full registered player list with IDs, matched back to pool rows by nation + name. Until then, drafting proceeds on internal IDs.

### Polling strategy
- Cron-based, NOT live (event-driven)
- Stats pulled after each match concludes
- End-of-day reconciliation pull to catch any stat corrections

### Backup plan
- ESPN scraping as a deeper fallback if API-Football has an outage

### Nation status
Each nation tracks two derived fields:
- `eliminated_at_round` — null while the nation is alive in the real tournament; set to the round identifier of the round in which the nation was knocked out (e.g., `group_md3`, the real R32, the real R16) once eliminated.
- `next_fixture_id` — the nation's upcoming real-world fixture, null when eliminated or when the next round's schedule has not yet been published.

Player-level status (eliminated vs. active, next match info) is **always derived from the player's nation via join**, never stored on the player. When a real-world fixture finalizes, a background job recomputes affected nations' `next_fixture_id` and sets `eliminated_at_round` on any nation that was knocked out by that fixture.

### Ownership status (distinct from nation status)
Nation status (above) is derived and never stored on the player. **Ownership** status — whether a player is rostered, on waivers, or a free agent *within a given league* — is a separate axis and IS stored. It cannot be derived from nation: two leagues have different ownership maps over the same player pool. (The invariant test covers the waiver resolver in isolation; initial-draft ownership coverage lives in picks.test.ts. True cross-row atomicity is a structural guarantee from the shared transaction, not yet covered by a DB-integration test.)

Ownership is tracked in `waiver_player_status` (`league_id`, `player_id`, `status`, `eligible_at`, `current_fantasy_round_id`). The `waiver_availability_status` enum is `rostered | on_waivers | free_agent`. This is the authoritative ownership source the waiver/FA logic branches on.

The `rosters` table independently encodes roster membership. These two are dual sources for the rostered case and MUST stay consistent: every ownership transition (award, drop, FCFS pickup) writes both `rosters` and `waiver_player_status` inside a single `db.transaction`. An invariant test asserts they never disagree. (Earlier design framing treated ownership as derived from row presence with no status enum; the implemented model stores it explicitly. This subsection reflects what is built.)

The UI displays each player's nation status as either the next fixture (opponent + kickoff time) when active, or "Eliminated" when not.

### Player rankings (draft cheat sheet)
A sidecar `player_rankings` table provides draft-assistance data — a global (not league-scoped) cheat sheet, the same for every league. Schema: `player_id` (PK, FK → `players.id`, ON DELETE CASCADE), `o_rank` (nullable int — overall projected rank across all WC players), `play_status` (nullable `play_status` enum), `o_rank_overridden` / `status_overridden` (booleans, default false — a recompute skips admin-corrected rows), `updated_at`.

The `play_status` enum: `definite_starter`, `probable_starter`, `possible_starter`, `probable_substitute`, `possible_substitute`, `wont_play_much`.

The raw projection inputs live in `player_projections` (`player_id` PK/FK → `players.id` CASCADE, 22 nullable numeric stat columns mirroring the CSV — minutes, goals, assists, shots, shots_on_goal, chances_created, passes, crosses, accurate_crosses, interceptions, tackles, tackles_won, blocks, clearances, clean_sheets, goals_conceded, saves, fouls_suffered, fouls_committed, yellow_cards, red_cards — `updated_at`). Stored separately from `player_rankings` so O-Rank can be recomputed if §6 rules change without re-ingesting, and so the full projection is available to surface on the cheat-sheet UI. Migration 0012.

**Data source and derivation:** O-Rank derives from projected fantasy points. A user-provided projections CSV (`data/soccer-projections.csv`, ~1,246 players, RotoWire-sourced per-player projected season stats) is ingested by `scripts/ingest-projections.ts` (`db:ingest-projections`): each row is name-matched to a `players` row (within nation, via a multi-step normalizer — accent/Turkish-char folding, Arabic/Central-Asian transliteration folding, short-name⊂long-name, plus a small explicit override map for nickname/wrong-first-name cases), its 22 projected stats stored in `player_projections`, then run through the §6 `scorePlayer` engine (same scoring path as real play) to produce `projected_points`. Players are sorted by projected_points descending and assigned integer `o_rank` 1..N, written to `player_rankings`. 1,240/1,246 matched; the ~6 unmatched are players the projection source doesn't cover (left null — no rank on the cheat sheet). Penalties saved/missed and own goals aren't in the projection source, so projected points omit those low-frequency terms. Play-status derivation (from the depth-chart PDF) is the remaining piece (§16).

### Stats ingestion & live scoring

The stats ingestion job is the writer that populates `player_match_scores.points` — the
authoritative per-player base that matchup resolution, standings, and the bracket all read.
It is a single **stateless, idempotent catch-up sweep**: each run reconciles the DB against
API-Football for any fixture in a polling window, recomputes fantasy scores from current
stats, and finalizes rounds that have settled. It tracks no notion of "which matchday is
today" — everything derives from fixture state, so a missed or delayed run is harmless (the
next run catches up).

**Trigger.** Driven by an external scheduler — **GitHub Actions** on a `schedule` cron
(~every 5 min during the tournament) plus `workflow_dispatch` for manual runs — because the
Vercel Hobby tier caps crons at once-per-day. The route is authenticated
(`Authorization: Bearer ${CRON_SECRET}`), so the trigger is swappable (GitHub Actions, an
uptime pinger, or the one spare Hobby cron as a daily fallback). The sweep is idempotent, so
double-triggering is harmless.

**Settle constant.** `ROUND_SETTLE_HOURS = 1` (named, tunable) governs both poll cooldown
and resolve settle: a fixture is polled while live or until it has been finalized for
`ROUND_SETTLE_HOURS`; a round is finalized once all its fixtures have been finalized for at
least `ROUND_SETTLE_HOURS`. Semantics: one hour after a match finalizes, the stats present
at that moment become permanent. A correction arriving later than an hour does not
auto-update standings — it is an admin re-trigger (§13).

**Per-tick behavior:**
1. *Scope check (no API calls):* find fixtures that are live OR finalized within
   `ROUND_SETTLE_HOURS` (using `real_fixtures.finalized_at`), and any round whose fixtures
   are all finalized ≥ `ROUND_SETTLE_HOURS` ago with `fantasy_rounds.stats_ingested_at`
   null. If both empty, exit.
2. *Poll + score (API calls; match-state-agnostic):* for each in-window fixture, fetch
   events + players, derive per-player stats (including live `conceded_while_on_pitch`),
   upsert `player_match_stats`, and recompute `player_match_scores.points` via the §6
   `scorePlayer` engine (never overwriting a row that has `override_points` set). Raw
   payloads stored in `raw_api_responses` (hashed) for audit / change detection. On the
   boundary tick where a fixture crosses `ROUND_SETTLE_HOURS`, this poll runs before the
   resolve step so resolution sees the freshest stats.
3. *Resolve settled rounds (no API calls; conditional):* for each settled, unresolved
   round, in order: refresh nation status (`next_fixture_id` and `eliminated_at_round`),
   run `resolveMatchups` → `computeStandings` → `resolveBracket`, set `stats_ingested_at`,
   and schedule the `waiver_processing_events` row if the round's completion is
   waiver-relevant (MD1, MD2, fantasy `qf`/`sf` → normal-claim event; MD3 → mass-release
   event per the existing two-phase cron; no normal-claim window after MD3). `scheduledAt`
   = 9am ET next morning (13:00 UTC during the tournament; UTC-only Vercel cron, EDT in
   June–July).

**Live scoring.** `getMatchupsForRound` computes manager totals on read from
`player_match_scores`, so step-2 updates surface immediately as a live, provisional matchup
total and winning/losing state. Authoritative matchup results, standings, and bracket
advancement are written only by step 3, after the settle period. Live scores are provisional
and may revise (VAR reversals, stat corrections); appearance points and clean sheets resolve
only at/after full time. The UI labels live scores as provisional.

**Nation elimination.** `eliminated_at_round` is set in step 3 — not from absence of a next
fixture (a nation between knockout rounds also lacks one but is not eliminated). It is set to
the fantasy-round identifier of the real round that eliminated the nation, via the seed's
`mapRound` mapping (real R32 → `qf`, R16 → `sf`, QF → `final`; group-stage bottom-2 after MD3
→ `group_md3`). Consumed by the live-view nation-status display and the waiver cron's
free-agent logic, not by bracket advancement (which uses `group_standings` +
`winner_manager_id`).

**Cross-cron ordering.** The waiver cron (separate, daily, 9am ET — §8) is gated on
`stats_ingested_at`: it processes a due `waiver_processing_events` row only if that round is
resolved, deferring otherwise. The ~5-min sweep resolves rounds an hour after their last
fixture, well before the 9am waiver run, so the gate is effectively always satisfied while
remaining the correctness guarantee. This ensures waiver free-agent decisions never run on
stale nation status.

**API budget.** API-Football paid plan: 7,500 req/day. Polling is bounded to a ~3-hour
window per fixture (≤2h live + 1h cooldown) at ~2 calls/poll. The busiest group-stage day
stays well under ~25% of the daily ceiling; off-days cost ~zero (the scope check no-ops
without API calls).

---

## 11. Architecture

### Tech stack
- **Language:** TypeScript
- **Frontend:** Next.js 16 (App Router, React) + Tailwind CSS + shadcn/ui
- **Backend:** Next.js API routes / server actions (no separate backend service)
- **Database:** PostgreSQL via Supabase
- **ORM:** Drizzle ORM (`drizzle-orm` + `drizzle-kit` for migrations)
- **Auth:** Supabase Auth via `@supabase/ssr` (cookie-backed sessions, magic link only)
- **Cron:** Vercel Cron (Hobby tier, daily) for the waiver job; GitHub Actions (`schedule` ~every 5 min) for the stats-ingestion sweep (Hobby crons cap at once-per-day — see §10)
- **Deployment:** Vercel (auto-deploy from GitHub)

### Hosting
| Component | Host | Cost |
|---|---|---|
| Frontend + API routes | Vercel (Hobby tier) | $0 |
| Database | Supabase (free tier) | $0 |
| Auth | Supabase (bundled) | $0 |
| Cron jobs | Vercel Cron (Hobby) + GitHub Actions | $0 |
| Stats API | API-Football (paid plan) | paid |
| Domain | `footyfantasy.app` (custom, via Cloudflare registrar + DNS) | ~$14/yr |

**Total: ~$0/month infrastructure** (Vercel + Supabase free tiers), plus the
API-Football paid plan for stats.

### Source control
- **GitHub** private repo, named `footy-fantasy`
- Branch strategy: `main` is live, `develop` for in-progress work, feature branches for individual features

---

## 12. Backup Strategy

Three layers:

1. **Git (per-feature):** Every meaningful change committed before merging to `main`
2. **GitHub remote (continuous off-machine):** Push to GitHub at end of every work session
3. **Database backups:**
   - Supabase native daily backups (7-day retention, free tier)
   - Optional weekly `pg_dump` snapshots before major schema changes

---

## 13. Admin & Commissioner Powers

### Admin powers (app-level)
The admin (project owner) has full access to the underlying database and can perform any state correction. **No dedicated UI is built for admin operations in MVP** — admin work happens via direct database manipulation through the Supabase dashboard or scripts run via Claude Code.

**Operations handled via DB:**
- Manual stat / fantasy point override
- Note: player_match_stats.red_card is a boolean column; the scoring engine takes redCards as a number (0/1), bridged at ingestion. An admin correcting a red card directly in the DB sets the boolean. Scoring re-triggers re-derive from raw stats, so the bool is the correct thing to edit — but the engine never reads the schema column directly, so a manual points override (player_match_scores.override_points) is the more reliable correction path for a disputed score.
- Manual waiver controls (process); corrections via direct roster moves, not waiver-event undo
- Lineup reset for any manager
- Initial draft order override
- Group assignment override (manual entry)
- Changing league format mid-season
- Adding/removing managers from a locked league
- Restoring deleted players
- Swapping rosters or correcting any other state
- Creating new leagues, managing user accounts across leagues

### Commissioner powers (future)
The commissioner role is reserved for future per-league self-management. When implemented, commissioners will have an in-app UI for the league-scoped subset of the operations above (stat overrides, waiver controls, lineup resets, draft order override, group assignment override). Out of scope for MVP — admin handles these via DB for now.

---

## 14. MVP Feature List

### Accounts & league
- Email login (magic link only for MVP, per §9)
- Admin user creation, kick/reset
- League settings page (read-only for managers, editable for admin)

### Draft
- Async snake draft with pick clock
- Draft board with pick history, current picker, time remaining
- Player pool view: filter by nation, position, search by name

### Group draw event
- Live group draw UI (slot-by-slot reveal)

### Roster & lineups
- View own roster
- Drop a player; claim a free agent
- Set starting XI with formation selector (validates legal formation)
- Captain & Vice-Captain selection per matchday
- Per-player lineup lock at nation kickoff

### Free agency & waivers
- Drop player → 24-hour waiver window
- Claim player from waivers (with conditional drop)
- Mass-waiver event after group stage (eliminated nations' players)

### Scoring & matchups
- Background job pulls stats from API-Football
- Fantasy point calculation per scoring rules
- Live matchup view (your team vs opponent, points by player)
- Group standings table (W/L/D/PF)
- Knockout bracket display (format-specific shape)

### Explicitly out of MVP / V1
- In-app admin/commissioner UI (all admin operations via DB for MVP — see §13)
- Pre-rank queue
- Notifications (in-app, email, push)
- Draft chat
- Mock draft mode
- Auction draft format
- Suggested lineups
- Lineup analysis ("optimal lineup")
- League chat / message board
- Matchday digest emails
- Reactions / emoji
- Power rankings
- Trading
- Player news / injury feeds
- Player projections

---

## 15. Working Model

### Workflow: hybrid
- **Strategy & design discussions:** Web chat (this interface), within the project
- **Implementation:** Claude Code on local MacBook Pro
- **Single source of truth:** This DESIGN.md, stored both in project knowledge (chat) and in the repo (Claude Code reads via CLAUDE.md)

### Plan & development environment
- **Subscription:** Claude Pro ($20/mo). May temporarily upgrade to Max 5x if rate-limited during heavy build phases.
- **Development machine:** MacBook Pro
- **Repo location:** Local clone on MacBook

### Pre-feature checkpoint workflow
Before implementing any new feature:
1. Confirm clean Git state
2. Create feature branch
3. Build feature
4. Test locally
5. Commit and merge to `main`
6. Push to GitHub
7. Vercel auto-deploys

---

## 16. Open Items

### Complete (backend/logic, merged to main)
- Repo, scaffolding, schema, migrations, RLS, seed
- Auth (magic link, profile-mirroring trigger, permission helpers) and admin bootstrap procedure
- League creation (DB-direct per §13; no UI)
- Initial async snake draft system
- Group draw + slot assignment → schedule generation (creates the full group-stage AND knockout `fantasy_matchups` skeleton; knockout rows carry seed sources with null managers)
- Lineup backend (formation validation, captain/VC, per-player kickoff lock, auto-rollover read)
- Scoring engine (§6, pure function) + starting-XI lineup aggregation (§5)
- Free agency + waivers (drop window, weekly processing, claim resolution, conditional drops)
- Group-stage → knockout transition + supplemental redraft (§7 redraft, §8 mass-release, priority reset, +1h first-knockout waiver event)
- Matchup resolution + group standings + knockout bracket — read models AND the writers that populate them: `resolveMatchups` (per-round scoring → matchup results), `computeStandings` (§2 chain → ranked `group_standings`), `resolveBracket` (seed resolution + round-by-round advancement, 8-team bye auto-win). Live matchup view computes the in-progress round on read; finalized rounds read stored scores.
- Stats ingestion + live scoring sweep (§6/§10) — unit-tested, NOT yet validated end-to-end against the deployed DB. The stateless idempotent catch-up sweep: derives concededWhileOnPitch from events/subs (full Vitest coverage incl. the §6 855767 own-goal and 855736 VAR/sub/red-card cases), writes player_match_stats, recomputes player_match_scores.points via the §6 engine (override_points preserved via SQL CASE), refreshes nation status, resolves settled rounds (resolveMatchups→computeStandings→resolveBracket) one hour after last fixture finalizes, schedules waiver events, gated against the waiver cron via stats_ingested_at. Cron route (Bearer ${CRON_SECRET}) + GitHub Actions trigger (~5 min) wired. mapRound R16→sf bug fixed; CRON_SECRET set across .env.local/Vercel/GitHub.

All of the above is backend/logic only. No UI exists yet — UI is deliberately the final phase so look-and-feel is built once, consistently.

### Remaining before MVP
- **UI** — all views: draft board, group draw, roster/lineup, waivers/FA, live matchup, group standings, knockout bracket.

- **FULL-SEASON VALIDATION CAMPAIGN COMPLETE (June 5–7).** The entire backend was validated end-to-end against the deployed DB on an isolated 16-team validation league: initial draft (224 picks) → group draw + schedule → group stage MD1–MD3 (real 2022 WC stats replayed via per-fixture remap through the live ingestion sweep) → final standings + advancement → synthetic knockout fixtures → nation + manager elimination → mass-release → supplemental redraft (by-need order, snake, auto-pick, opt-out, frozen pool) → priority reset + first-knockout waiver event → knockout ingestion + bracket advancement (qf→sf→final) → champion. All §2/§3/§5/§6/§7/§8/§10 invariants confirmed: scoring engine + concededWhileOnPitch derivation (incl. own-goal 855767), multi-matchday standings accumulation, the §2 tiebreaker chain (head-to-head fired on a real tie), the §7 by-need tiebreaker (three-way tie resolved by group-stage PF), winner-type AND standing-type bracket seed resolution, knockout elimination via winner flags, nation-status recompute repointing nextFixtureId across rounds, and the §10 ownership dual-write invariant (zero violations across all phases).

  **Six production bugs were surfaced and fixed — all would have hit the live league, none caught by the 480 unit tests:** (1) mapRound R16→qf miswiring; (2) initial-draft picks bypassing applyOwnershipTransition, leaving waivers/FA nonfunctional; (3) upsertPlayerMatchStats null-crash on API-null penalty/card fields (fixed at derivation source, conceded.ts); (4) resolveBracket locking seeds at first resolution instead of re-resolving as standings change; (5) leagueMemberships.eliminatedAtRound never written, so mass-release would over-drop eliminated managers' locked rosters; (6) unhandled 23505 on concurrent picks. (Plus the picks-contract isComplete/isFinalPick rot, fixed early.)

  **Validated only on 16-team format.** The 8-team bye logic (qf BYE auto-win, §3) remains unit-test-only — a UI-first 8-team campaign re-run is planned to close this and exercise the live experience.

### Remaining gaps before June 11 (tracked, not bugs)
- **drafting→group_stage transition** — to be implemented as the UI "Finalize Draft" action (commissioner/admin confirms after draft completes → runGroupDraw fires + status flips → live group draw presented). Not a standalone backend fix; built with the UI.
- **knockouts→complete transition** — not wired into resolveMatchups/resolveBracket; needs an explicit completion path after the final resolves (likely the cron settle path, or a UI/admin action). Real league hits this in July.
- **Knockout round-string verification** — mapRound's "Round of 32"/"Round of 16"/"Quarter-finals" are best-guess 2026 strings; confirm against a live /fixtures/rounds?league=1&season=2026 call before the real R32 (June 28). Flagged in round-map.ts.
- **8-team bye logic** — unit-tested only; covered by the planned 8-team UI campaign.

### Remaining before MVP
- **UI** — all views. None built yet. The bulk of remaining work before June 11.
### Known follow-ups (non-blocking)
- **Schema-drift audit:** migrations 0007/0008 were authored and their code tested (against mocks) before the schema reached the live DB. A reconciliation pass should confirm every column the merged code references exists in the deployed database, to catch any further drift before the real draft.
- **Drizzle migration chain — reconciled against deployed DB (June 3). A drift audit against the deployed DB found migration 0006 (add_waiver_claim_rank) present on disk and in the journal but never applied — its ledger row was absent and waiver_claims.rank was missing — a residue of the earlier manual ledger reconciliation (Path 2), which had dropped 0006's row while 0005 and 0007–0009 applied normally. Fixed by applying 0006's ALTER TABLE manually and backfilling its __drizzle_migrations row (hash = SHA256 of the migration file, created_at = journal when). Ledger now matches journal (10 rows) and db:generate reports "no schema changes." All migrations 0000–0009 are confirmed applied to the deployed DB; future migrations can use normal db:migrate without manual reconciliation.
- **Draft-pick return contract unified (June 4).** submitRedraftPick previously returned isComplete while the dispatcher and initial-draft path used isFinalPick, bridged by a manual rename in picks.ts that had silently rotted (stale picks.test.ts assertion). Both paths now return isFinalPick; the bridge is gone (picks.ts redraft branch is a plain pass-through). Suite 471/471.
- **`drafting→group_stage` transition unimplemented (found June 4).** §9's state machine specifies this transition as an admin "run group draw and confirm" action, but runGroupDraw does not flip leagues.status and no confirm action exists — after the draw the league sits in `drafting` with a complete matchup skeleton. For validation, status is set manually (§13 DB op). For MVP this needs an admin UI button (commissioner action later) that performs the confirm. Likely composed with the post-draft ownership-init action (below) into a single "Finalize Draft" button, since both fire at the same moment.
- **Initial-draft ownership writes fixed (June 4).** The initial-draft pick path (picks.ts) was inserting into `rosters` raw, bypassing applyOwnershipTransition — so drafted players had no `waiver_player_status` row (status=rostered), violating the §10 dual-write invariant, and undrafted players were never placed on waivers (§8 "initial draft aftermath" unimplemented). Both would have left waivers/FA completely non-functional in the real league (submitWaiverClaim and the waiver cron both branch on waiver_player_status). Fixed: picks.ts now routes through applyOwnershipTransition (rostered row written atomically in the pick transaction); a new server module `src/lib/draft/init-ownership.ts` (`initDraftOwnership(leagueId)`, idempotent, set-based) populates undrafted players as on_waivers with eligible_at = draft.completedAt + 24h, exposed via scripts/init-draft-ownership.ts and intended for a future admin UI button. The initial-draft path was the only ownership-granting code bypassing applyOwnershipTransition; all others (redraft, FCFS, drops, waiver cron) were already correct.
- **`nations.fifa_code` has collisions** (found June 8 during projection ingest): AUS maps to both Australia and Austria, IRA to both Iran and Iraq. The projection matcher bypasses the column with an explicit code map, but any code that joins on `fifa_code` for those four nations will mismatch. Audit/fix before anything relies on it.

---

## 17. Timeline (Approximate)

| Date | Milestone |
|---|---|
| Now (May 5) | Setup: Claude Code, repo, Supabase, API key |
| Mid-May | Schema, auth, basic CRUD |
| Late May | Draft system fully functional |
| Late May | Mock draft with friends to stress-test |
| Early June | Lineup setting, scoring engine, stats integration |
| ~June 7 | League draft happens |
| June 8 | MVP locked, last bug fixes |
| **June 11** | **Real-world tournament begins** |
| June 11–27 | Group stage; iterate on V1 features in real time |
| June 28 | Redraft + knockouts begin |
| July ~12 | Fantasy champion crowned |
