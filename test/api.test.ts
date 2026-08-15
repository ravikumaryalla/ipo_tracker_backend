/**
 * End-to-end API tests against a real Postgres.
 *
 * The most important thing here is the ownership suite. Under Supabase, Row
 * Level Security enforced "you only see your own rows" in the database, below
 * every query. That is gone: the only thing standing between user A and user
 * B's credentials now is a `where` clause in each handler. A handler that
 * forgets one is a data leak that nothing else would catch, so every user-owned
 * resource gets an explicit cross-account test.
 *
 * Needs a throwaway database:
 *
 *   docker run --rm -e POSTGRES_PASSWORD=pw -p 5433:5432 -d postgres:17
 *   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5433/postgres \
 *     npx prisma migrate deploy
 *   TEST_DATABASE_URL=... npm test
 *
 * Skipped, loudly, when TEST_DATABASE_URL is unset — so `npm test` still runs
 * the pure suites on a machine with no database.
 */
import type { Express } from 'express';
import request from 'supertest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Env is validated at import time, so these have to be in place before any
// module under test is loaded.
process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgresql://unused';
process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-long-enough-to-pass-validation';
process.env.JOB_SECRET ??= 'test-job-secret-that-is-long-enough-to-pass-validation';
process.env.NODE_ENV = 'test';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.warn('TEST_DATABASE_URL not set — skipping API integration tests.');
}

describeDb('API', () => {
  let app: Express;
  let prisma: import('@prisma/client').PrismaClient;

  /** A signed-up user plus a demat account and an application belonging to them. */
  type Fixture = {
    token: string;
    userId: string;
    accountId: string;
    ipoId: string;
    applicationId: string;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email, password: 'correct horse battery', display_name: 'Test' })
      .expect(201);
    return { token: res.body.access_token, userId: res.body.user.id };
  }

  async function seedUser(email: string): Promise<Fixture> {
    const { token, userId } = await signUp(email);

    const account = await request(app)
      .post('/accounts')
      .set(auth(token))
      .send({
        broker_id: null,
        nickname: 'Zerodha main',
        pan: 'ABCDE1234F',
        enc: { password_enc: 'ciphertext-stand-in' },
      })
      .expect(201);

    const ipo = await request(app)
      .post('/ipos')
      .set(auth(token))
      .send({
        symbol: `T${Date.now() % 100000}`,
        company_name: 'Test Co',
        segment: 'MAINBOARD',
        open_date: '2026-08-01',
        close_date: '2026-08-03',
        allotment_date: null,
        listing_date: null,
        price_band_min: 100,
        price_band_max: 105,
        lot_size: 15,
        registrar: null,
      })
      .expect(201);

    const application = await request(app)
      .post('/applications')
      .set(auth(token))
      .send({
        ipo_id: ipo.body.id,
        demat_account_id: account.body.id,
        category: 'RETAIL',
        lots: 1,
        bid_price: 105,
        lot_size: 15,
      })
      .expect(201);

    return {
      token,
      userId,
      accountId: account.body.id,
      ipoId: ipo.body.id,
      applicationId: application.body.id,
    };
  }

  beforeAll(async () => {
    ({ prisma } = await import('../src/db.js'));
    ({ app } = { app: (await import('../src/app.js')).createApp() });
  });

  beforeEach(async () => {
    // Order matters: children before parents. Deleting users would cascade, but
    // being explicit keeps a failure legible.
    await prisma.ipoApplication.deleteMany();
    await prisma.credentialHistory.deleteMany();
    await prisma.dematAccount.deleteMany();
    await prisma.ipoGmp.deleteMany();
    await prisma.ipo.deleteMany();
    await prisma.syncLog.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe('auth', () => {
    it('signs up, refreshes, and signs out', async () => {
      const signup = await request(app)
        .post('/auth/signup')
        .send({ email: 'a@example.com', password: 'correct horse battery', display_name: 'A' })
        .expect(201);

      expect(signup.body.access_token).toBeTruthy();
      expect(signup.body.user.email).toBe('a@example.com');

      // Signup must create the profile too — the vault gate reads it on first
      // unlock, and a user without one could never set a PIN.
      await request(app).get('/profile').set(auth(signup.body.access_token)).expect(200);

      const refreshed = await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: signup.body.refresh_token })
        .expect(200);

      expect(refreshed.body.access_token).toBeTruthy();

      // Refresh tokens rotate: the one just spent must not work twice.
      await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: signup.body.refresh_token })
        .expect(401);

      await request(app)
        .post('/auth/logout')
        .send({ refresh_token: refreshed.body.refresh_token })
        .expect(204);

      await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: refreshed.body.refresh_token })
        .expect(401);
    });

    it('signs in with the right password and refuses the wrong one', async () => {
      await signUp('b@example.com');

      await request(app)
        .post('/auth/login')
        .send({ email: 'b@example.com', password: 'correct horse battery' })
        .expect(200);

      const bad = await request(app)
        .post('/auth/login')
        .send({ email: 'b@example.com', password: 'wrong' })
        .expect(401);

      // The app maps this code to specific copy, so it is API surface.
      expect(bad.body.error.code).toBe('invalid_credentials');
    });

    it('refuses a duplicate email and a too-short password', async () => {
      await signUp('c@example.com');

      const dupe = await request(app)
        .post('/auth/signup')
        .send({ email: 'c@example.com', password: 'correct horse battery' })
        .expect(400);
      expect(dupe.body.error.code).toBe('email_taken');

      const weak = await request(app)
        .post('/auth/signup')
        .send({ email: 'd@example.com', password: '123' })
        .expect(400);
      expect(weak.body.error.code).toBe('weak_password');
    });

    it('rejects an unauthenticated request', async () => {
      await request(app).get('/accounts').expect(401);
      await request(app).get('/accounts').set({ Authorization: 'Bearer nonsense' }).expect(401);
    });
  });

  // -------------------------------------------------------------------------

  describe('ownership (the RLS replacement)', () => {
    let alice: Fixture;
    let bob: Fixture;

    beforeEach(async () => {
      alice = await seedUser('alice@example.com');
      bob = await seedUser('bob@example.com');
    });

    it('does not list another user rows', async () => {
      const accounts = await request(app).get('/accounts').set(auth(bob.token)).expect(200);
      expect(accounts.body.map((a: { id: string }) => a.id)).toEqual([bob.accountId]);

      const applications = await request(app)
        .get('/applications')
        .set(auth(bob.token))
        .expect(200);
      expect(applications.body.map((a: { id: string }) => a.id)).toEqual([bob.applicationId]);
    });

    it('refuses to read, edit, or delete another user demat account', async () => {
      await request(app).get(`/accounts/${alice.accountId}`).set(auth(bob.token)).expect(404);
      await request(app)
        .patch(`/accounts/${alice.accountId}`)
        .set(auth(bob.token))
        .send({ nickname: 'stolen' })
        .expect(404);
      await request(app).delete(`/accounts/${alice.accountId}`).set(auth(bob.token)).expect(404);

      // And Alice's row is untouched.
      const still = await request(app)
        .get(`/accounts/${alice.accountId}`)
        .set(auth(alice.token))
        .expect(200);
      expect(still.body.nickname).toBe('Zerodha main');
    });

    it('refuses to read, edit, or delete another user application', async () => {
      await request(app)
        .patch(`/applications/${alice.applicationId}`)
        .set(auth(bob.token))
        .send({ status: 'ALLOTTED', shares_allotted: 15 })
        .expect(404);
      await request(app)
        .delete(`/applications/${alice.applicationId}`)
        .set(auth(bob.token))
        .expect(404);
    });

    it('does not stamp another user application as checked', async () => {
      await request(app)
        .post('/applications/touch-checked')
        .set(auth(bob.token))
        .send({ ids: [alice.applicationId] })
        .expect(200)
        .expect((res) => expect(res.body.updated).toBe(0));

      const row = await prisma.ipoApplication.findUnique({ where: { id: alice.applicationId } });
      expect(row?.allotmentCheckedAt).toBeNull();
    });

    it('hides a manually-added IPO from everyone but its author', async () => {
      await request(app).get(`/ipos/${alice.ipoId}`).set(auth(bob.token)).expect(404);

      const list = await request(app).get('/ipos').set(auth(bob.token)).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).toEqual([bob.ipoId]);
    });

    it('refuses an application filed against someone else demat account', async () => {
      await request(app)
        .post('/applications')
        .set(auth(bob.token))
        .send({
          ipo_id: bob.ipoId,
          demat_account_id: alice.accountId,
          category: 'RETAIL',
          lots: 1,
          bid_price: 105,
          lot_size: 15,
        })
        .expect(404);
    });

    it('refuses to edit a synced IPO', async () => {
      const synced = await prisma.ipo.create({
        data: { symbol: 'SYNCED', companyName: 'Synced Co', source: 'NSE', createdBy: null },
      });

      // Readable by anyone...
      await request(app).get(`/ipos/${synced.id}`).set(auth(bob.token)).expect(200);
      // ...but not writable, or one user's edit would rewrite what everyone sees.
      const res = await request(app)
        .patch(`/ipos/${synced.id}`)
        .set(auth(bob.token))
        .send({ company_name: 'Hijacked' })
        .expect(403);
      expect(res.body.error.code).toBe('read_only_ipo');
    });

    it('scopes the profile to the caller', async () => {
      await request(app)
        .patch('/profile')
        .set(auth(alice.token))
        .send({ vault_salt: 'alice-salt' })
        .expect(200);

      const bobProfile = await request(app).get('/profile').set(auth(bob.token)).expect(200);
      expect(bobProfile.body.vault_salt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('applications', () => {
    it('enforces the SEBI one-bid-per-account-per-category rule', async () => {
      const alice = await seedUser('alice@example.com');

      const res = await request(app)
        .post('/applications')
        .set(auth(alice.token))
        .send({
          ipo_id: alice.ipoId,
          demat_account_id: alice.accountId,
          category: 'RETAIL',
          lots: 2,
          bid_price: 105,
          lot_size: 15,
        })
        .expect(409);

      // The client turns exactly this code into "already applied" copy.
      expect(res.body.error.code).toBe('23505');

      // A different category is a legitimate second bid.
      await request(app)
        .post('/applications')
        .set(auth(alice.token))
        .send({
          ipo_id: alice.ipoId,
          demat_account_id: alice.accountId,
          category: 'SHAREHOLDER',
          lots: 1,
          bid_price: 105,
          lot_size: 15,
        })
        .expect(201);
    });

    it('computes amounts server-side rather than trusting the client', async () => {
      const alice = await seedUser('alice@example.com');
      const rows = await request(app).get('/applications').set(auth(alice.token)).expect(200);

      // 1 lot × 15 shares × ₹105.
      expect(rows.body[0].shares_applied).toBe(15);
      expect(rows.body[0].amount_blocked).toBe(1575);
      expect(rows.body[0].amount_currently_blocked).toBe(1575);
      expect(typeof rows.body[0].bid_price).toBe('number');
    });
  });

  // -------------------------------------------------------------------------

  describe('accounts', () => {
    it('archives prior ciphertext and the update together', async () => {
      const alice = await seedUser('alice@example.com');

      await request(app)
        .patch(`/accounts/${alice.accountId}`)
        .set(auth(alice.token))
        .send({
          nickname: 'Zerodha main',
          enc: { password_enc: 'new-ciphertext' },
          history: [{ field: 'password', old_value_enc: 'ciphertext-stand-in' }],
          password_changed: true,
        })
        .expect(200);

      const history = await prisma.credentialHistory.findMany({
        where: { dematAccountId: alice.accountId },
      });
      expect(history).toHaveLength(1);
      expect(history[0]?.oldValueEnc).toBe('ciphertext-stand-in');

      const row = await prisma.dematAccount.findUnique({ where: { id: alice.accountId } });
      expect(row?.passwordEnc).toBe('new-ciphertext');
      expect(row?.passwordChangedAt).not.toBeNull();
    });

    it('never returns a plaintext secret', async () => {
      const alice = await seedUser('alice@example.com');
      const res = await request(app)
        .get(`/accounts/${alice.accountId}`)
        .set(auth(alice.token))
        .expect(200);

      // Ciphertext in, ciphertext out — the server has no key and must not
      // acquire one.
      expect(res.body.password_enc).toBe('ciphertext-stand-in');
      expect(res.body).not.toHaveProperty('password');
      // PAN is the one deliberate plaintext exception.
      expect(res.body.pan).toBe('ABCDE1234F');
    });

    it('omits secrets from the summary list', async () => {
      const alice = await seedUser('alice@example.com');
      const res = await request(app).get('/accounts').set(auth(alice.token)).expect(200);

      expect(res.body[0]).toEqual({
        id: alice.accountId,
        broker_id: null,
        nickname: 'Zerodha main',
        is_active: true,
        password_changed_at: null,
        updated_at: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('jobs', () => {
    it('rejects a missing or wrong job secret', async () => {
      await request(app).post('/jobs/sync-ipos').expect(401);

      const res = await request(app)
        .post('/jobs/sync-ipos')
        .set({ 'x-job-secret': 'wrong' })
        .expect(401);
      expect(res.body.error.code).toBe('invalid_job_secret');
    });

    it('does not accept a user access token in place of the job secret', async () => {
      const alice = await seedUser('alice@example.com');
      await request(app).post('/jobs/check-allotments').set(auth(alice.token)).expect(401);
    });
  });
});
