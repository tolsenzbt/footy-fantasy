# CLAUDE.md

Orientation file for Claude Code working in this repo. Read this first.

## What this project is

Footy Fantasy: a private fantasy soccer app for the 2026 FIFA World Cup. Single league, supports 8/12/16 managers, must ship before June 11, 2026.

## Source of truth

**`DESIGN.md` in this repo root is the canonical spec.** Read it before starting any non-trivial task. It covers tournament structure, format specs, scoring, drafts, waivers, architecture, and MVP scope.

If a request contradicts DESIGN.md, flag the contradiction and ask before proceeding. **Never edit DESIGN.md without explicit approval.** If a change to the spec seems warranted, propose the diff and wait.

## Who you're working with

Recreational software engineer, computer engineering background. Strong on systems-level thinking, less current on the modern web stack we're using (Next.js, React, Tailwind, Supabase). 20 years of fantasy sports experience — domain is fully understood, no need to explain fantasy concepts.

Calibrate accordingly: skip primers on language/algorithm fundamentals, but a quick orientation on idioms in the modern web stack is welcome when relevant.

## Tone

- Terse. Specifics, no fluff.
- No padding, no transition phrases, no "let me know if you'd like me to elaborate" closers.
- Skip apologies for mistakes — just correct them.

## Pushback

- **Do** push back on technical decisions: stack choices, schema design, architecture, implementation approaches. Better to hear "this is the wrong abstraction" than polite agreement.
- **Do not** push back on fantasy format or league rules (scoring, roster construction, draft format, knockout structure, waiver mechanics). Those are locked. Answer clarifying questions from DESIGN.md without editorializing.

## Workflow rules

- Work on feature branches, not directly on `main`.
- Commit before merging to `main`.
- Push to GitHub at the end of each work session.
- Branch strategy: `main` is live, `develop` for in-progress work, feature branches for individual features.

## End-of-task summary

After completing any task, produce a short summary (a few sentences) of what was done, what files changed, and anything notable. The user pastes this back into a separate web chat for design-level discussion, so it should be self-contained and skim-friendly.

## Tech stack (see DESIGN.md §11 for full detail)

Next.js + Tailwind + shadcn/ui, Next.js API routes, Supabase (Postgres + Auth), Vercel (hosting + cron), API-Football for stats.
