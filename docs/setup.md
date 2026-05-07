# Footy Fantasy — Setup Guide

## Environment variables

Copy `.env.example` to `.env.local` and fill in all values:

```
NEXT_PUBLIC_SUPABASE_URL      — Supabase project URL (Settings → API)
NEXT_PUBLIC_SUPABASE_ANON_KEY — Supabase anon/public key (Settings → API)
SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key (Settings → API) — NEVER NEXT_PUBLIC_
DATABASE_URL                  — Postgres connection string (Settings → Database → Connection string → Nodejs)
API_FOOTBALL_KEY              — API-Football v3 key
```

## Admin bootstrap

After first deploy (or `npm run dev`), the first person to log in gets a plain `manager` profile. Promote them to admin via Supabase dashboard SQL editor:

```sql
update public.profiles
set is_app_admin = true
where email = 'your@email.com';

-- Verify:
select email, is_app_admin from public.profiles;
```

## Magic link local dev workaround

Supabase does not send real emails in local development unless you configure an SMTP provider. To retrieve the magic link without email:

1. Go to Supabase dashboard → Authentication → Logs
2. Find the most recent "Send OTP" event
3. Expand it — the magic link URL is in the log payload
4. Paste that URL into your browser

## Running locally

```bash
npm install
npm run dev
# Visit http://localhost:3000
```

## Database

```bash
npm run db:generate   # generate a migration from schema changes
npm run db:migrate    # apply pending migrations to Supabase
npm run db:studio     # open Drizzle Studio
npm run db:seed       # seed tournament reference data (see scripts/seed.ts)
```
