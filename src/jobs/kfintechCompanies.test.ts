/**
 * The cache exists for one concrete reason: a single "Check status" tap can
 * cover twenty applications, and every one of them whose IPO has no company id
 * yet would otherwise re-download KFintech's whole React bundle. That is a
 * behaviour no amount of reading the code proves, so it is asserted here
 * against a counted fetch.
 *
 * `../db.js` is mocked out rather than imported: this module only needs prisma
 * for the persist helpers, and instantiating a real PrismaClient would make a
 * pure cache test depend on a database URL.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../db.js', () => ({ prisma: {} }));

const { clearKfintechCompaniesCache, getKfintechCompanies } = await import(
  './kfintechCompanies.js'
);

const BUNDLE =
  'const rf=JSON.parse(\'[{"clientId":"1","name":"MILKY MIST DAIRY FOOD LIMITED"}]\'),of={};';

const HOMEPAGE = '<html><script src="./static/js/main.abc123.js"></script></html>';

function mockFetch(): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.endsWith('/') ? HOMEPAGE : BUNDLE;
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock as unknown as jest.Mock;
}

describe('getKfintechCompanies', () => {
  beforeEach(() => clearKfintechCompaniesCache());

  it('fetches the homepage and the bundle, and parses the dropdown out of it', async () => {
    mockFetch();
    await expect(getKfintechCompanies()).resolves.toEqual([
      { clientId: '1', name: 'MILKY MIST DAIRY FOOD LIMITED' },
    ]);
  });

  it('serves later calls from cache — one scrape, not one per caller', async () => {
    const fetchMock = mockFetch();
    await getKfintechCompanies();
    await getKfintechCompanies();
    await getKfintechCompanies();
    // Two requests total: the homepage and the bundle it points at.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers into a single in-flight scrape', async () => {
    const fetchMock = mockFetch();
    await Promise.all([getKfintechCompanies(), getKfintechCompanies(), getKfintechCompanies()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure — the next caller gets a fresh attempt', async () => {
    let attempt = 0;
    globalThis.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/')) {
        attempt += 1;
        if (attempt === 1) return { ok: false, status: 503 } as unknown as Response;
        return { ok: true, status: 200, text: async () => HOMEPAGE } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => BUNDLE } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(getKfintechCompanies()).rejects.toThrow('KFintech homepage responded 503');
    await expect(getKfintechCompanies()).resolves.toHaveLength(1);
  });

  it('throws rather than returning an empty list when the bundle shape is gone', async () => {
    globalThis.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.endsWith('/') ? HOMEPAGE : 'nothing that looks like the company array';
      return { ok: true, status: 200, text: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(getKfintechCompanies()).rejects.toThrow('yielded no company entries');
  });
});
