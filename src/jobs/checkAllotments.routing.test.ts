/**
 * Which registrar an application's check is actually sent to.
 *
 * This is the part that was wrong for a year: everything went to KFintech, so a
 * MUFG or Bigshare issue answered "nothing on file" forever and its
 * applications reported "allotment not released yet" for good. The routing is
 * therefore asserted directly — not through a mocked HTTP layer, but by
 * standing in for each registrar's resolver and recording who was asked, in
 * what order, and who ended up being queried.
 *
 * `../db.js` and the three registrar clients are mocked: this file is about the
 * decision, not the scraping, and a real PrismaClient would make it depend on a
 * database URL.
 */
import { jest } from '@jest/globals';

// checkAllotments pulls in jobLog, which reads the validated env. None of these
// are used — ../db.js is mocked out below — but env.ts refuses to load without
// them, and that failure happens at import time.
process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.JWT_SECRET ??= 'unused-in-this-suite-but-long-enough-to-pass';
process.env.JOB_SECRET ??= 'unused-in-this-suite-but-long-enough-to-pass';

type Ipo = {
  id: string;
  companyName: string;
  registrar: string | null;
  registrarCompanyId: string | null;
  registrarKey: string | null;
  allotmentDate: Date | null;
};

/** Which registrars' company lists were consulted, in order. */
let resolveCalls: string[] = [];
/** Which registrar was actually asked about the PAN. */
let askCalls: string[] = [];
/** Company ids each registrar's list will admit to holding, by IPO id. */
let listHolds: Record<string, string | null> = {};

const updated: { id: string; data: Record<string, unknown> }[] = [];

const resolver = (registrar: string) =>
  jest.fn(async (ipoId: string) => {
    resolveCalls.push(registrar);
    return listHolds[`${registrar}:${ipoId}`] ?? null;
  });

const searcher = (registrar: string) =>
  jest.fn(async () => {
    askCalls.push(registrar);
    return null;
  });

jest.unstable_mockModule('../db.js', () => ({
  prisma: {
    ipoApplication: {
      findMany: jest.fn(async () => candidates),
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push({ id: args.where.id, data: args.data });
        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    pushToken: { findMany: jest.fn(async () => []) },
    syncLog: { create: jest.fn(async () => ({})) },
  },
}));

jest.unstable_mockModule('./kfintechCompanies.js', () => ({
  KFINTECH_BASE: 'https://ipostatus.kfintech.com',
  resolveKfintechCompanyId: resolver('KFINTECH'),
}));

jest.unstable_mockModule('./mufgCompanies.js', () => ({
  MUFG_REGISTRAR: 'MUFG Intime',
  resolveMufgCompanyId: resolver('MUFG'),
  searchMufgByPan: searcher('MUFG'),
}));

jest.unstable_mockModule('./bigshareCompanies.js', () => ({
  BIGSHARE_REGISTRAR: 'Bigshare',
  resolveBigshareCompanyId: resolver('BIGSHARE'),
  searchBigshareByPan: searcher('BIGSHARE'),
}));

const { checkApplications, registrarFor } = await import('./checkAllotments.js');

let candidates: unknown[] = [];

/** One APPLIED application against the given IPO, with a PAN on file. */
function application(ipo: Partial<Ipo>) {
  return {
    id: 'app-1',
    userId: 'user-1',
    sharesApplied: 70,
    applicationNo: null,
    ipo: {
      id: 'ipo-1',
      companyName: 'TECHNOCRAFT VENTURES LIMITED',
      registrar: null,
      registrarCompanyId: null,
      registrarKey: null,
      allotmentDate: new Date('2026-08-14'),
      ...ipo,
    },
    dematAccount: { pan: 'ABCDE1234F' },
  };
}

beforeEach(() => {
  resolveCalls = [];
  askCalls = [];
  listHolds = {};
  updated.length = 0;
  candidates = [];
  // KFintech is the only registrar reached over plain fetch rather than through
  // a mocked client; answer it "nothing on file" so it never leaves the process.
  globalThis.fetch = jest.fn(async () => {
    askCalls.push('KFINTECH');
    return { ok: true, status: 404 } as unknown as Response;
  }) as unknown as typeof fetch;
});

describe('registrarFor', () => {
  it.each([
    ['MUFG Intime', 'MUFG'],
    ['MUFG Intime India Pvt. Ltd.', 'MUFG'],
    // Retired name; rows written before the rebrand still carry it.
    ['Link Intime India Private Limited', 'MUFG'],
    ['Bigshare Services Pvt. Ltd.', 'BIGSHARE'],
    // The feed publishes this spelling too, with no space before "Ltd.".
    ['Bigshare Services Pvt.Ltd.', 'BIGSHARE'],
  ])('reads %s as %s', (name, expected) => {
    expect(registrarFor(name)).toBe(expected);
  });

  /**
   * The subtle one. 'KFintech' is the `registrar` column's own default, so a row
   * nobody has ever assigned a registrar to looks identical to one KFintech
   * genuinely registers. Returning null means "no hint" — which sends
   * companyIdFor to every list rather than to KFintech's alone.
   */
  it.each([null, '', 'KFintech', 'Some Registrar Nobody Has Heard Of'])(
    'gives no hint for %p',
    (name) => {
      expect(registrarFor(name)).toBeNull();
    },
  );
});

describe('routing', () => {
  it('asks the registrar a stored registrar_key names, consulting no lists', async () => {
    candidates = [application({ registrarKey: 'BIGSHARE', registrarCompanyId: '9043' })];

    await checkApplications('user-1', ['app-1']);

    expect(askCalls).toEqual(['BIGSHARE']);
    // The whole point of storing the pair: no scrape on the second check.
    expect(resolveCalls).toEqual([]);
  });

  it('sends a Bigshare-registered issue to Bigshare, not KFintech', async () => {
    candidates = [application({ registrar: 'Bigshare Services Pvt. Ltd.' })];
    listHolds['BIGSHARE:ipo-1'] = '9043';

    await checkApplications('user-1', ['app-1']);

    expect(resolveCalls[0]).toBe('BIGSHARE');
    expect(askCalls).toEqual(['BIGSHARE']);
  });

  it('still asks MUFG first when the column says MUFG', async () => {
    candidates = [application({ registrar: 'MUFG Intime' })];
    listHolds['MUFG:ipo-1'] = '11921';

    await checkApplications('user-1', ['app-1']);

    expect(resolveCalls[0]).toBe('MUFG');
    expect(askCalls).toEqual(['MUFG']);
  });

  /**
   * The permanently-dead-button case. A row carrying the bare 'KFintech'
   * default that KFintech does not actually register used to stop at KFintech's
   * list and report "not released yet" forever.
   */
  it('tries every list when the registrar column is only the column default', async () => {
    candidates = [application({ registrar: 'KFintech' })];
    listHolds['BIGSHARE:ipo-1'] = '9043';

    await checkApplications('user-1', ['app-1']);

    expect(resolveCalls).toEqual(['KFINTECH', 'MUFG', 'BIGSHARE']);
    expect(askCalls).toEqual(['BIGSHARE']);
  });

  it('reports no-match, and asks nobody, when no list holds the issue', async () => {
    candidates = [application({})];

    const results = await checkApplications('user-1', ['app-1']);

    expect(resolveCalls).toEqual(['KFINTECH', 'MUFG', 'BIGSHARE']);
    expect(askCalls).toEqual([]);
    expect(results).toEqual([
      { id: 'app-1', outcome: 'no-match', message: 'allotment not released yet' },
    ]);
  });

  it('refuses to query a registrar when the account has no PAN', async () => {
    candidates = [{ ...application({ registrarKey: 'BIGSHARE', registrarCompanyId: '9043' }), dematAccount: { pan: null } }];

    const results = await checkApplications('user-1', ['app-1']);

    expect(askCalls).toEqual([]);
    expect(results[0].outcome).toBe('no-pan');
  });

  // The on-demand path deliberately skips the sweep's 21:00–24:00 due-date
  // gate: an explicit user tap is its own justification, and this is the only
  // way to check an allotment published the next morning.
  it('checks an issue whose allotment date has not arrived', async () => {
    candidates = [
      application({
        registrarKey: 'BIGSHARE',
        registrarCompanyId: '9043',
        allotmentDate: new Date('2099-01-01'),
      }),
    ];

    await checkApplications('user-1', ['app-1']);

    expect(askCalls).toEqual(['BIGSHARE']);
  });
});
