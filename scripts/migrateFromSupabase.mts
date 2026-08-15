/**
 * One-off: copy the Supabase project into the Postgres behind DATABASE_URL.
 *
 * This is the REST-based alternative to the pg_dump procedure documented in
 * importSupabase.ts. It exists because neither psql nor pg_dump is installed on
 * the machine this ran from, and the volumes involved (a few hundred rows) do
 * not justify installing them.
 *
 * The two schemas are identical — same table names, same columns, same ids —
 * so rows are inserted verbatim by their own JSON keys rather than mapped
 * through Prisma's camelCase model fields. Postgres infers each parameter's
 * type from the column it lands in, so dates, decimals, enums and uuids all
 * arrive as the strings PostgREST emits and are coerced on the way in.
 *
 * Idempotent: every insert is ON CONFLICT DO NOTHING, so a partial run can be
 * repeated.
 *
 * ONE THING DOES NOT SURVIVE THIS ROUTE. Supabase keeps password hashes in
 * `auth.users.encrypted_password`, and the admin API this script uses to
 * enumerate users does not expose that column — only a direct Postgres
 * connection can read it. Users are therefore created with an unusable
 * placeholder hash and must go through password reset. That is a deliberate,
 * visible failure rather than a silent one: `--require-hashes` refuses to
 * import any user whose hash is missing, if you would rather wait and do this
 * over a direct connection.
 *
 *   npx tsx scripts/migrateFromSupabase.mts [--dry-run] [--require-hashes]
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import bcrypt from 'bcryptjs';

import { prisma } from '../src/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const REQUIRE_HASHES = process.argv.includes('--require-hashes');

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const BASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env');
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

type Row = Record<string, unknown>;

/** Every row of one table. Paged, because PostgREST caps a response at 1000. */
async function fetchAll(table: string): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`, {
      headers,
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Row[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/**
 * The target's own column types, as `{ column → udt_name }`.
 *
 * Needed because Prisma sends every raw parameter as text, and Postgres will
 * not implicitly coerce text into uuid, date, timestamptz or an enum — the
 * insert fails with 42804. `udt_name` is the exact type name to cast to and
 * covers enums as well as builtins, so `$n::${udt}` works uniformly.
 */
async function columnTypes(table: string): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string; udt_name: string }[]>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    table,
  );
  return new Map(rows.map((r) => [r.column_name, r.udt_name]));
}

/**
 * Insert rows verbatim. The column list comes from the first row's own keys;
 * PostgREST returns every column of the table, including nulls, so that list is
 * complete rather than whatever the first row happened to populate.
 *
 * Any source column the target does not have is dropped rather than failing the
 * run — the two schemas are meant to be identical, but a column Supabase kept
 * and this schema dropped should not stop the other 300 rows.
 */
async function insertAll(table: string, rows: Row[], conflictTarget = 'id'): Promise<number> {
  if (rows.length === 0) return 0;

  const types = await columnTypes(table);
  const columns = Object.keys(rows[0]).filter((c) => types.has(c));
  const dropped = Object.keys(rows[0]).filter((c) => !types.has(c));
  if (dropped.length > 0) console.log(`  ${table}: ignoring source columns ${dropped.join(', ')}`);

  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map((c, i) => `$${i + 1}::${types.get(c)}`).join(', ');
  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO NOTHING`;

  let inserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => {
      const v = row[c];
      // jsonb columns arrive as parsed objects; hand them back as text so the
      // column's own type does the coercion.
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    inserted += await prisma.$executeRawUnsafe(sql, ...values);
  }
  return inserted;
}

async function main() {
  console.log(DRY_RUN ? '--- DRY RUN: reading only ---\n' : '--- migrating into DATABASE_URL ---\n');

  // 1. users, from the auth admin API. Everything else has a foreign key into
  //    this table, so nothing can land before it.
  const authRes = await fetch(`${BASE}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!authRes.ok) throw new Error(`auth admin: ${authRes.status} ${await authRes.text()}`);
  const authUsers = ((await authRes.json()) as { users?: Row[] }).users ?? [];

  const missingHashes = authUsers.filter((u) => !u.encrypted_password);
  if (missingHashes.length > 0 && REQUIRE_HASHES) {
    throw new Error(
      `${missingHashes.length} of ${authUsers.length} users have no readable password hash. ` +
        'Re-run without --require-hashes to import them with a placeholder, or migrate over a ' +
        'direct Postgres connection to carry the real hashes across.',
    );
  }

  const userRows: Row[] = authUsers.map((u) => ({
    id: u.id,
    email: String(u.email ?? '').trim().toLowerCase(),
    // No readable hash over REST — see the header. A hash of 32 random bytes is
    // a valid bcrypt string that no password can ever produce, so the account
    // exists, keeps its id, and can only be entered via password reset.
    password_hash:
      (u.encrypted_password as string | undefined) ??
      bcrypt.hashSync(randomBytes(32).toString('hex'), 10),
    email_verified_at: u.email_confirmed_at ?? u.created_at ?? new Date().toISOString(),
    created_at: u.created_at ?? new Date().toISOString(),
    updated_at: u.updated_at ?? u.created_at ?? new Date().toISOString(),
  }));

  console.log(`users            source=${authUsers.length} (placeholder hashes: ${missingHashes.length})`);

  // 2. The application tables, parents before children.
  //
  //    `brokers` is seeded by the init migration with ids of its own making,
  //    and demat_accounts.broker_id points at the SOURCE ids — so the seed is
  //    cleared first and replaced wholesale. Safe only because it happens
  //    before any demat_accounts row exists to be orphaned.
  const TABLES = [
    'brokers',
    'profiles',
    'demat_accounts',
    'ipos',
    'ipo_applications',
    'ipo_gmp',
    'push_tokens',
    'credential_history',
    'sync_log',
  ];

  const source: Record<string, Row[]> = {};
  for (const table of TABLES) {
    source[table] = await fetchAll(table);
    console.log(`${table.padEnd(17)}source=${source[table].length}`);
  }

  if (DRY_RUN) {
    console.log('\ndry run: nothing written');
    await prisma.$disconnect();
    return;
  }

  console.log('\n--- writing ---');
  console.log(`users            inserted=${await insertAll('users', userRows)}`);

  const seededBrokers = await prisma.broker.count();
  if (seededBrokers > 0 && source.brokers.length > 0) {
    await prisma.$executeRawUnsafe('DELETE FROM "brokers"');
    console.log(`brokers          cleared ${seededBrokers} seeded rows first`);
  }

  for (const table of TABLES) {
    // password_reset_tokens keys on token_hash, everything else on id.
    console.log(`${table.padEnd(17)}inserted=${await insertAll(table, source[table])}`);
  }

  console.log('\n--- verifying ---');
  const counts: [string, number][] = [
    ['users', await prisma.user.count()],
    ['brokers', await prisma.broker.count()],
    ['profiles', await prisma.profile.count()],
    ['demat_accounts', await prisma.dematAccount.count()],
    ['ipos', await prisma.ipo.count()],
    ['ipo_applications', await prisma.ipoApplication.count()],
    ['ipo_gmp', await prisma.ipoGmp.count()],
    ['push_tokens', await prisma.pushToken.count()],
    ['credential_history', await prisma.credentialHistory.count()],
    ['sync_log', await prisma.syncLog.count()],
  ];
  for (const [name, n] of counts) {
    const expected = name === 'users' ? userRows.length : (source[name]?.length ?? 0);
    const flag = n === expected ? 'ok' : `MISMATCH expected ${expected}`;
    console.log(`${name.padEnd(20)} target=${String(n).padEnd(6)} ${flag}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
