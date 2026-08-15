# IPO Tracker API

Express + Prisma + Postgres. Replaces the Supabase backend: PostgREST, GoTrue
auth, the two Deno Edge Functions, and the `pg_cron` schedule.

## What lives where

| | |
|---|---|
| `src/app.ts` | route wiring; `src/index.ts` is the listener |
| `src/routes/` | one file per resource, each scoped to `req.userId` |
| `src/services/auth.ts` | password hashing, sessions, reset tokens |
| `src/jobs/` | the two scrapers, ported from the Edge Functions |
| `src/wire.ts` | Prisma rows → the JSON the app parses |
| `prisma/` | schema and migrations |

## Security model

Supabase enforced "you only see your own rows" with Row Level Security, in the
database, below every query. **That is gone.** The only thing separating one
user's credentials from another's is now a `where` clause in each handler.

A handler that forgets one is a data leak nothing else will catch, so:

- every user-owned query filters on `userId(req)`;
- `test/api.test.ts` has a cross-account test for each user-owned resource, and
  new resources need one too.

The vault is unaffected. Credentials arrive as ciphertext produced on the device
and are stored and returned unchanged — the server has no key and must never
acquire one. `demat_accounts.pan` is the one deliberate plaintext column, because
the allotment job has to query KFintech with it.

## Local development

```sh
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, JOB_SECRET
npm install
npx prisma migrate deploy
npm run dev                   # http://localhost:8080
```

Generate the two secrets with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

A throwaway database for tests:

```sh
docker run --name ipotest -e POSTGRES_PASSWORD=pw -p 5433:5432 -d postgres:17
DATABASE_URL=postgresql://postgres:pw@localhost:5433/postgres npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5433/postgres npm test
```

`npm test` without `TEST_DATABASE_URL` still runs the parser and wire suites and
skips the API tests with a warning.

## Scheduled jobs

`POST /jobs/sync-ipos` and `POST /jobs/check-allotments`, both behind an
`x-job-secret` header. Point any external scheduler at them on the cadences the
`pg_cron` jobs used:

| Job | Cron (UTC) | Local |
|---|---|---|
| `sync-ipos` | `0 4 * * *` | 09:30 IST |
| `sync-ipos` | `30 13 * * *` | 19:00 IST |
| `check-allotments` | `*/15 * * * *` | — |

The allotment sweep only acts inside a three-hour window (21:00 IST to midnight
on an IPO's allotment date), so running it every 15 minutes is cheap the rest of
the day.

Both jobs record every attempt in `sync_log`, which is what drives the staleness
banner in the app. They degrade rather than throw: one provider failing never
stops the others.

## The scrapers

None of the upstream sources publishes a documented API — these are the endpoints
their own websites call, and they can change shape without notice. The pure
parsing logic (`src/jobs/*.parse.ts`, `ipogyani.ts`) moved over from the Deno
functions **unchanged**, along with its tests. Those 113 tests passing is the
evidence the port is faithful; keep it that way when touching them.

## Migrating from Supabase

See the header of `scripts/importSupabase.ts` for the full ordered runbook. The
short version:

1. `prisma migrate deploy` against the new database.
2. Export `auth.users` to CSV and import it — this preserves user ids, so every
   foreign key in the dump still resolves. Supabase stores bcrypt hashes, which
   this server verifies directly, so **nobody has to reset a password**.
3. `pg_dump --data-only` the `public` schema across, excluding `brokers` (the
   migration seeds it).
4. Re-run the import with `--profiles-only` to backfill any missing profile.

Step 3 must come after step 2, and `profiles` must come from the dump: it holds
`vault_salt`, `vault_verifier`, and `vault_recovery_blob`. Regenerating those
would leave every user permanently unable to unlock their own credentials.
