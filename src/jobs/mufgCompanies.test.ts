/**
 * The MUFG client's network behaviour: the cache that keeps a burst of checks
 * to one scrape, and the exact shape of the search request.
 *
 * The request shape is asserted rather than trusted because every field of it
 * is undocumented and load-bearing. `CHKVAL` picks which column MUFG searches —
 * send '2' instead of '1' and it looks up a PAN as an application number and
 * answers "no records" forever, which is indistinguishable from an allotment
 * that is not out yet.
 *
 * `../db.js` is mocked out: this module only needs prisma for `saveMufgMatch`,
 * and a real PrismaClient would make a pure test depend on a database URL.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../db.js', () => ({ prisma: {} }));

const { clearMufgCompaniesCache, getMufgCompanies, mufgToken, searchMufgByPan } = await import(
  './mufgCompanies.js'
);

const COMPANIES =
  '<NewDataSet><Table><company_id>11921</company_id><companyname>Leap India Limited - IPO</companyname></Table></NewDataSet>';

type Call = { url: string; body: Record<string, string> };

/** Records every WebMethod call and answers each one plausibly. */
function mockFetch(answers: { search?: string } = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: unknown, init: unknown) => {
    const url = String(input);
    const raw = (init as { body?: string } | undefined)?.body ?? '{}';
    calls.push({ url, body: JSON.parse(raw) });

    const d = url.endsWith('/GetDetails')
      ? COMPANIES
      : url.endsWith('/generateToken')
        ? '924649117'
        : (answers.search ?? '<NewDataSet />');

    return { ok: true, status: 200, json: async () => ({ d }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('mufgToken', () => {
  // AES-128-CBC, PKCS7, key and IV both the ASCII "8080808080808080" — the
  // constants their own encVal() hardcodes. This value was produced by that
  // function in the browser; if node's crypto ever disagrees, the token we send
  // stops being the token their page sends.
  it('reproduces CryptoJS AES output for a known nonce', () => {
    expect(mufgToken('924649117')).toBe('LgxmXqozF3epSwB2o+lcEw==');
  });

  it('is deterministic — no random IV', () => {
    expect(mufgToken('1')).toBe(mufgToken('1'));
    expect(mufgToken('1')).not.toBe(mufgToken('2'));
  });
});

describe('getMufgCompanies', () => {
  beforeEach(() => clearMufgCompaniesCache());

  it('reads the dropdown from GetDetails', async () => {
    mockFetch();
    await expect(getMufgCompanies()).resolves.toEqual([
      { clientId: '11921', name: 'Leap India Limited' },
    ]);
  });

  it('serves later calls from cache — one scrape, not one per caller', async () => {
    const calls = mockFetch();
    await getMufgCompanies();
    await getMufgCompanies();
    await getMufgCompanies();
    expect(calls).toHaveLength(1);
  });

  it('collapses concurrent callers into a single in-flight scrape', async () => {
    const calls = mockFetch();
    await Promise.all([getMufgCompanies(), getMufgCompanies(), getMufgCompanies()]);
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failure — the next caller gets a fresh attempt', async () => {
    let attempt = 0;
    globalThis.fetch = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 503 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ d: COMPANIES }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(getMufgCompanies()).rejects.toThrow(/503/);
    await expect(getMufgCompanies()).resolves.toHaveLength(1);
  });

  it('treats an empty dropdown as a failure rather than caching "nothing"', async () => {
    globalThis.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ d: '<NewDataSet />' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(getMufgCompanies()).rejects.toThrow(/no companies/i);
  });

  it('names the rate limiter rather than reporting a bare 429', async () => {
    globalThis.fetch = jest.fn(
      async () => ({ ok: false, status: 429 }) as unknown as Response,
    ) as unknown as typeof fetch;

    await expect(getMufgCompanies()).rejects.toThrow(/rate-limiting/i);
  });
});

describe('searchMufgByPan', () => {
  beforeEach(() => clearMufgCompaniesCache());

  it('fetches a nonce, encrypts it, and sends the PAN search their page sends', async () => {
    const calls = mockFetch();
    await searchMufgByPan('11921', 'ABCDE1234F');

    expect(calls.map((c) => c.url)).toEqual([
      'https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/generateToken',
      'https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/SearchOnPan',
    ]);
    expect(calls[1].body).toEqual({
      clientid: '11921',
      PAN: 'ABCDE1234F',
      IFSC: '',
      // 1 = search by PAN. Nothing else in this object matters more.
      CHKVAL: '1',
      token: mufgToken('924649117'),
    });
  });

  it('returns the XML untouched, for the parser to judge', async () => {
    mockFetch({ search: '<NewDataSet><Table1><Msg>No records</Msg></Table1></NewDataSet>' });
    await expect(searchMufgByPan('11921', 'ABCDE1234F')).resolves.toContain('No records');
  });

  it('fetches a fresh nonce per search — theirs is single-use', async () => {
    const calls = mockFetch();
    await searchMufgByPan('11921', 'ABCDE1234F');
    await searchMufgByPan('11921', 'ABCDE1234F');
    expect(calls.filter((c) => c.url.endsWith('/generateToken'))).toHaveLength(2);
  });
});
