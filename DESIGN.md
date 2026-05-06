# Footy Fantasy — Design Document

**Project:** A fantasy soccer app for the 2026 FIFA World Cup, built for a private league of 8, 12, or 16 friends.

**Status:** Pre-implementation. All format and architectural decisions in this document are locked unless explicitly revisited.

**Last updated:** May 6, 2026 (v3 — admin/commissioner/manager role split, round identifier clarification, nation status model, eliminated-roster handling clarified, MVP commissioner UI deferred)

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
1. Total fantasy points scored across all matchups (Points For)
2. Head-to-head result between tied managers
3. Highest single-matchday score
4. Random

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
- 1A and 1B receive first-round byes
- `qf`: 2A vs 3B, 2B vs 3A
- `sf`: 1A vs (2B/3A winner), 1B vs (2A/3B winner)
- `final`: `sf` winners

(`1A` = 1st-place finisher of Group A, etc.)

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
- Captain/Vice-Captain selection locks at the same time (per-player, when their nation kicks off)
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

---

## 7. Drafts

### Initial Draft (all formats)
- **Format:** Reverse snake
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
- **Order:** By need (count of auto-dropped eliminated-nation players, descending), tiebreaker = group-stage points (descending)
- **Format:** Reverse snake
- **Rounds:** 10 maximum, regardless of league size
- **Pick clock:** 30 seconds per pick (rapid-fire)
- **Pass option:** Managers can opt out of the redraft at any time, skipping all remaining picks
- **Full-roster picks:** If a manager is at 14 players when picking, they must drop a player on the same turn
- **Available pool:** All non-rostered players (free agents + waivered eliminated-nation players)
- **Exception:** Eliminated managers' rosters are locked; their players are NOT available

---

## 8. Waivers & Free Agency

### Core principle
No live free agency during matches. All player movement is committed before kickoff and processed at scheduled times.

### Waiver priority
- **Group stage:** Initial order is reverse of initial draft order. Successful claims send claimant to bottom; others shift up. Failed claims do not affect priority. Priority persists through entire group stage.
- **Knockouts:** Priority resets after the redraft. New order = reverse of redraft order. Eliminated managers are removed.

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
Waiver claims can include a "drop-if-successful" designation. If multiple claims share the same drop player and the first succeeds, subsequent claims auto-void.

### Initial draft aftermath
All undrafted players sit on waivers for 24 hours after the draft concludes, then become free agents.

### Mass release at end of group stage
- All players from non-advancing nations on **advancing managers' rosters** are auto-dropped at conclusion of `group_md3`
- These players sit on waivers through the redraft
- Players selected in the redraft come off waivers
- Unselected players clear waivers 1 hour after redraft completes

Auto-drop applies only to advancing managers' rosters. Non-advancing (eliminated) managers' rosters are locked intact at end of group stage; their players (whether from advancing or eliminated nations) are not returned to the pool.

### Eliminated managers
Rosters lock at end of group stage. Players on eliminated managers' rosters are removed from the active pool entirely (regardless of whether their nation is still alive in the real tournament).

---

## 9. Authentication & League Management

- **Auth model:** Email-based, magic link or password (Supabase Auth)
- **User creation:** Admin creates accounts and assigns to league
- **No social login** (Google/Apple OAuth out of scope)
- **No public registration**

### Roles
The system distinguishes three roles:

- **Admin:** App-level operator. Not associated with any specific league. Can create leagues, manage user accounts across leagues, perform out-of-app database operations, and exercise all in-league powers in any league. The project owner holds this role.
- **Commissioner:** League-scoped operator role reserved for future use. Will allow per-league self-management (in-app UI for waiver overrides, lineup resets, etc.) without admin involvement. Defined in the schema and permission model so it can be expanded later. Not assigned for the inaugural league — the admin handles all league operations directly via DB.
- **Manager:** A league participant. Drafts a team, sets lineups, makes waiver claims. The admin joins leagues as a manager under a separate user account to participate as a regular player.

### League lock
The following are determined and frozen when the admin clicks "Start Draft":
- League size (8, 12, or 16) — cannot change after this
- Manager list — no adds/drops to the league after this
- Initial draft order — generated (random) or admin-set
- Match schedule — automatically derived from league size

The following are determined at the group draw event:
- Slot assignments (A1, B2, etc.)
- Group memberships (derived from slot)

---

## 10. Stats & Data Source

### Primary source
**API-Football** (api-football.com) free tier
- 100 requests/day limit
- 10 requests/minute rate limit
- All endpoints available on free tier
- Returns full match player stats in a single call per fixture

### Polling strategy
- Cron-based, NOT live (event-driven)
- Stats pulled after each match concludes
- End-of-day reconciliation pull to catch any stat corrections

### Backup plan
- Upgrade to API-Football Pro plan ($19/month) for the tournament duration if needed
- ESPN scraping as a deeper fallback

### Nation status
Each nation tracks two derived fields:
- `eliminated_at_round` — null while the nation is alive in the real tournament; set to the round identifier of the round in which the nation was knocked out (e.g., `group_md3`, the real R32, the real R16) once eliminated.
- `next_fixture_id` — the nation's upcoming real-world fixture, null when eliminated or when the next round's schedule has not yet been published.

Player-level status (eliminated vs. active, next match info) is **always derived from the player's nation via join**, never stored on the player. When a real-world fixture finalizes, a background job recomputes affected nations' `next_fixture_id` and sets `eliminated_at_round` on any nation that was knocked out by that fixture.

The UI displays each player's nation status as either the next fixture (opponent + kickoff time) when active, or "Eliminated" when not.

---

## 11. Architecture

### Tech stack
- **Language:** TypeScript
- **Frontend:** Next.js 15 (App Router, React) + Tailwind CSS + shadcn/ui
- **Backend:** Next.js API routes / server actions (no separate backend service)
- **Database:** PostgreSQL via Supabase
- **ORM:** Drizzle ORM (`drizzle-orm` + `drizzle-kit` for migrations)
- **Auth:** Supabase Auth
- **Cron:** Vercel Cron (free tier)
- **Deployment:** Vercel (auto-deploy from GitHub)

### Hosting
| Component | Host | Cost |
|---|---|---|
| Frontend + API routes | Vercel (Hobby tier) | $0 |
| Database | Supabase (free tier) | $0 |
| Auth | Supabase (bundled) | $0 |
| Cron jobs | Vercel Cron (free tier) | $0 |
| Stats API | API-Football (free tier) | $0 |
| Domain | Vercel subdomain (`footy-fantasy.vercel.app`) | $0 |

**Total: $0/month** with $19/month optional fallback.

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
- Manual waiver controls (process, undo)
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
- Email login (magic link or password)
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

## 16. Open Items (Pending First Implementation Session)

- Database schema design (Drizzle schema in `src/db/schema.ts`, migrations via `drizzle-kit`) — first engineering task once Claude Code is set up
- CLAUDE.md for the repo — short action-oriented file pointing Claude Code at this design doc
- GitHub repo creation and initial Next.js scaffolding
- Supabase project creation and connection setup
- API-Football account creation and key acquisition

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
