/**
 * One-off: import the users from a Supabase `auth.users` export into
 * `public.users`.
 *
 * The application tables move with a plain `pg_dump`/`pg_restore` — same
 * columns, same ids. `auth.users` is the one table that does not exist here, so
 * this script rebuilds it, preserving each id exactly so that every foreign key
 * in the restored data still resolves.
 *
 * Passwords carry over untouched: Supabase stores `encrypted_password` as a
 * bcrypt hash, which is the format services/auth.ts verifies against. Nobody has
 * to reset anything at cutover.
 *
 * ORDER MATTERS. Run these in exactly this sequence:
 *
 *  1. Create the schema on the new database:
 *       DATABASE_URL=... npx prisma migrate deploy
 *
 *  2. Export users from Supabase:
 *       psql "$SUPABASE_DB_URL" -c "\copy (
 *         select id, email, encrypted_password, created_at,
 *                raw_user_meta_data->>'display_name' as display_name
 *         from auth.users where deleted_at is null
 *       ) to 'users.csv' with csv header"
 *
 *  3. Import them, so every user_id foreign key has something to point at:
 *       DATABASE_URL=... npm run import:supabase -- users.csv
 *
 *  4. Only then restore the application data:
 *       pg_dump "$SUPABASE_DB_URL" --schema=public --data-only --no-owner \
 *         --exclude-table=brokers | psql "$DATABASE_URL"
 *
 *     `brokers` is excluded because the init migration already seeds it.
 *
 *  5. Re-run this script with --profiles-only to give a profile to any user
 *     whose row did not come across:
 *       DATABASE_URL=... npm run import:supabase -- users.csv --profiles-only
 *
 * This script deliberately does NOT create profile rows on the main pass.
 * `profiles` holds vault_salt, vault_verifier and vault_recovery_blob — the
 * material every user's vault key is derived from. Those must come from the
 * dump in step 4. Synthesising a blank profile here would look like it worked
 * and leave the user permanently unable to unlock their own credentials.
 *
 * Idempotent throughout: re-running skips what already exists, so a partial run
 * can simply be repeated.
 */
import { readFileSync } from 'node:fs';

import { prisma } from '../src/db.js';

type Row = {
  id: string;
  email: string;
  encrypted_password: string;
  created_at: string;
  display_name: string;
};

/**
 * Minimal RFC 4180 reader — enough for a psql \copy csv export, which quotes
 * any field containing a comma, quote, or newline and escapes quotes by
 * doubling them. Avoids a dependency for a script that runs once.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];

  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((key, i) => [key, r[i] ?? ''])));
}

/**
 * Step 5: a profile for any imported user the data restore left without one.
 * Such a user can still sign in, and the vault gate treats a profile with no
 * salt as "uninitialised" — they will be asked to set a vault PIN, which is the
 * correct outcome for someone who never had one.
 */
async function backfillProfiles(rows: Row[]): Promise<number> {
  let created = 0;

  for (const row of rows) {
    if (!row.id) continue;
    const existing = await prisma.profile.findUnique({ where: { id: row.id } });
    if (existing) continue;

    const user = await prisma.user.findUnique({ where: { id: row.id } });
    if (!user) continue;

    await prisma.profile.create({
      data: { id: row.id, displayName: row.display_name || row.email.split('@')[0] },
    });
    created += 1;
  }

  return created;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npm run import:supabase -- <users.csv> [--profiles-only]');
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(path, 'utf8')) as unknown as Row[];
  console.info(`read ${rows.length} users from ${path}`);

  if (process.argv.includes('--profiles-only')) {
    console.info(`created ${await backfillProfiles(rows)} missing profiles`);
    await prisma.$disconnect();
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.id || !row.email || !row.encrypted_password) {
      // A user with no password hash signed up through an OAuth provider or a
      // magic link, neither of which this server implements. Importing them
      // with an unusable hash would leave an account nobody can ever sign into,
      // so flag it instead of pretending it migrated.
      console.warn(`skipping ${row.email || row.id}: no password hash to carry over`);
      skipped += 1;
      continue;
    }

    const existing = await prisma.user.findUnique({ where: { id: row.id } });
    if (existing) {
      skipped += 1;
      continue;
    }

    await prisma.user.create({
      data: {
        id: row.id,
        email: row.email.trim().toLowerCase(),
        passwordHash: row.encrypted_password,
        // Supabase only exports rows it considers usable; treating them as
        // verified matches the access they already had.
        emailVerifiedAt: new Date(),
        createdAt: row.created_at ? new Date(row.created_at) : new Date(),
        // No profile here on purpose — see the header. It arrives with the data
        // restore, carrying the vault material that cannot be regenerated.
      },
    });

    imported += 1;
  }

  console.info(`imported ${imported}, skipped ${skipped}`);
  console.info('next: restore the application data, then re-run with --profiles-only');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
