/**
 * The Bigshare client's network behaviour: the cache that keeps a burst of
 * checks to one scrape, the dedupe that stops their years-deep archive from
 * disabling a check, and the exact shape of the search request.
 *
 * The request shape is asserted rather than trusted because every field of it
 * is undocumented and load-bearing. `SelectionType` picks which column Bigshare
 * searches — send 'AP' instead of 'PN' and it looks up a PAN as an application
 * number and answers "No data found" forever, which is indistinguishable from
 * an allotment that is not out yet.
 *
 * `../db.js` is mocked out: this module only needs prisma for
 * `saveBigshareMatch`, and a real PrismaClient would make a pure test depend on
 * a database URL.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../db.js', () => ({ prisma: {} }));

const {
  BIGSHARE_STATUS_URL,
  clearBigshareCompaniesCache,
  getBigshareCompanies,
  searchBigshareByPan,
} = await import('./bigshareCompanies.js');

const PAGE = `
  <select id="ddlCompany">
    <option>--Select Company--</option>
    <option value="9043">TECHNOCRAFT VENTURES LIMITED</option>
    <!-- <option value="586">METALIC TECHNOFORGE LIMITED</option> -->
  </select>
`;

type Call = { url: string; body: string | undefined };

function mockFetch(page = PAGE): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: unknown, init: unknown) => {
    const url = String(input);
    calls.push({ url, body: (init as { body?: string } | undefined)?.body });

    if (url.endsWith('/ipo_status.html')) {
      return { ok: true, status: 200, text: async () => page } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ d: { DPID: 'No data found' } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('getBigshareCompanies', () => {
  beforeEach(() => clearBigshareCompaniesCache());

  it('scrapes the dropdown out of the status page — there is no list API', async () => {
    const calls = mockFetch();
    await expect(getBigshareCompanies()).resolves.toEqual([
      { clientId: '9043', name: 'TECHNOCRAFT VENTURES LIMITED', archived: false },
      { clientId: '586', name: 'METALIC TECHNOFORGE LIMITED', archived: true },
    ]);
    expect(calls[0].url).toBe(BIGSHARE_STATUS_URL);
  });

  /**
   * `matchCompanyByName` refuses a tie on purpose — two entries scoring the
   * same make it return null rather than guess. Bigshare's archive is deep
   * enough that a company relisted, or listed once live and once commented out,
   * would otherwise silently disable its own check.
   */
  it('collapses a name listed twice, keeping the live entry', async () => {
    mockFetch(`
      <select id="ddlCompany">
        <option value="9043">TECHNOCRAFT VENTURES LIMITED</option>
        <!-- <option value="4300">Technocraft Ventures Ltd.</option> -->
      </select>
    `);
    await expect(getBigshareCompanies()).resolves.toEqual([
      { clientId: '9043', name: 'TECHNOCRAFT VENTURES LIMITED', archived: false },
    ]);
  });

  it('serves later calls from cache — one scrape, not one per caller', async () => {
    const calls = mockFetch();
    await getBigshareCompanies();
    await getBigshareCompanies();
    await getBigshareCompanies();
    expect(calls).toHaveLength(1);
  });

  it('collapses concurrent callers into a single in-flight scrape', async () => {
    const calls = mockFetch();
    await Promise.all([getBigshareCompanies(), getBigshareCompanies(), getBigshareCompanies()]);
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failure — the next caller gets a fresh attempt', async () => {
    let attempt = 0;
    globalThis.fetch = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 503 } as unknown as Response;
      return { ok: true, status: 200, text: async () => PAGE } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(getBigshareCompanies()).rejects.toThrow(/503/);
    await expect(getBigshareCompanies()).resolves.toHaveLength(2);
  });

  it('treats an empty dropdown as a failure rather than caching "nothing"', async () => {
    mockFetch('<html><body>maintenance</body></html>');
    await expect(getBigshareCompanies()).rejects.toThrow(/no company entries/i);
  });

  it('names the rate limiter rather than reporting a bare 429', async () => {
    globalThis.fetch = jest.fn(
      async () => ({ ok: false, status: 429 }) as unknown as Response,
    ) as unknown as typeof fetch;

    await expect(getBigshareCompanies()).rejects.toThrow(/rate-limiting/i);
  });
});

describe('searchBigshareByPan', () => {
  beforeEach(() => clearBigshareCompaniesCache());

  it('sends the single POST their page sends, PAN mode and all', async () => {
    const calls = mockFetch();
    await searchBigshareByPan('9043', 'ABCDE1234F');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails');
    // Their own payload: unquoted keys, single-quoted values, every unused
    // field present and empty. PN = search by PAN, and nothing else in this
    // string matters more.
    expect(calls[0].body).toBe(
      "{ Applicationno: '',Company: '9043',SelectionType: 'PN',PanNo: 'ABCDE1234F', " +
        "txtcsdl: '', txtDPID: '',txtClId: '',ddlType:'0',lang: 'en'}",
    );
  });

  it('needs no token round trip, unlike MUFG', async () => {
    const calls = mockFetch();
    await searchBigshareByPan('9043', 'ABCDE1234F');
    await searchBigshareByPan('9043', 'ABCDE1234F');
    expect(calls).toHaveLength(2);
  });

  it('returns the body untouched, for the parser to judge', async () => {
    mockFetch();
    await expect(searchBigshareByPan('9043', 'ABCDE1234F')).resolves.toEqual({
      d: { DPID: 'No data found' },
    });
  });

  // The payload is string-concatenated the way their page builds it, so a quote
  // in either field would corrupt the request rather than error. Neither value
  // should ever contain one; refusing is cheaper than finding out.
  it.each([
    ['client id', "90'43", 'ABCDE1234F'],
    ['PAN', '9043', "ABCDE'1234F"],
  ])('refuses a quote in the %s rather than sending a corrupt payload', async (_what, id, pan) => {
    const calls = mockFetch();
    await expect(searchBigshareByPan(id, pan)).rejects.toThrow(/quote/i);
    expect(calls).toHaveLength(0);
  });

  it('names the rate limiter rather than reporting a bare 429', async () => {
    globalThis.fetch = jest.fn(
      async () => ({ ok: false, status: 429 }) as unknown as Response,
    ) as unknown as typeof fetch;

    await expect(searchBigshareByPan('9043', 'ABCDE1234F')).rejects.toThrow(/rate-limiting/i);
  });
});
