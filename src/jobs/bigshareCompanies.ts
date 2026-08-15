/**
 * Bigshare Services' allotment-status client — the company dropdown, and the
 * PAN-keyed search behind it.
 *
 * The third sibling of kfintechCompanies.ts and mufgCompanies.ts, deliberately
 * built to the same shape: a TTL cache with in-flight sharing so one "Check
 * status" tap covering twenty applications costs one scrape, failures never
 * cached, and matches persisted onto the `ipos` row so the work is done once per
 * issue rather than once per check.
 *
 * The differences from the other two are both simplifications. There is no
 * company-list endpoint at all — the dropdown is markup inside the status page,
 * so the "scrape" is one GET of that page (see parseBigshareCompanies for the
 * commented-out-entries wrinkle that makes it interesting). And the search is a
 * single POST: no nonce to fetch and encrypt the way MUFG wants, and no
 * server-side captcha, because theirs is generated and verified entirely in the
 * browser before the request is sent.
 *
 * Public data on the list side; the PAN only ever appears in `searchBigshareByPan`.
 */
import { prisma } from '../db.js';
import { BIGSHARE_MODE_PAN, type BigshareCompany, parseBigshareCompanies } from './bigshare.parse.js';
import { matchCompanyByName, nameTokens } from './syncIpos.parse.js';

const BIGSHARE_BASE = 'https://ipo.bigshareonline.com';

export const BIGSHARE_STATUS_URL = `${BIGSHARE_BASE}/ipo_status.html`;

/**
 * Spelled exactly as ipogyani.ts's REGISTRARS table spells it. The column is
 * rendered straight into "Check allotment at …" on the IPO screen, so a second
 * spelling would surface as a second registrar.
 */
export const BIGSHARE_REGISTRAR = 'Bigshare';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

/** Same TTL and same reasoning as the other two: bursts, not freshness. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { companies: BigshareCompany[]; expiresAt: number } | null = null;
let inFlight: Promise<BigshareCompany[]> | null = null;

async function fetchBigshareCompanies(): Promise<BigshareCompany[]> {
  const res = await fetch(BIGSHARE_STATUS_URL, {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
  });
  if (res.status === 429) throw new Error('Bigshare is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`Bigshare status page responded ${res.status}`);

  const companies = dedupeByName(parseBigshareCompanies(await res.text()));
  if (companies.length === 0) throw new Error('Bigshare status page yielded no company entries');
  return companies;
}

/**
 * Collapse repeated names, keeping the live entry.
 *
 * Necessary because the archived half of the list is years deep and
 * `matchCompanyByName` refuses a tie on purpose — two entries scoring
 * identically make it return null rather than guess, so one company listed
 * twice would silently disable its own check. Keyed on `nameTokens` rather than
 * a local normaliser so this agrees with the matcher it is protecting.
 *
 * `parseBigshareCompanies` already returns live entries first, so first-wins is
 * prefer-live.
 */
function dedupeByName(companies: BigshareCompany[]): BigshareCompany[] {
  const seen = new Set<string>();
  const out: BigshareCompany[] = [];
  for (const company of companies) {
    const key = nameTokens(company.name).join('');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(company);
  }
  return out;
}

/**
 * The company list, from cache when it is still warm.
 *
 * Throws on a failed scrape rather than returning an empty list, for the same
 * reason getKfintechCompanies and getMufgCompanies do: "nothing listed" and
 * "the scrape broke" are indistinguishable to a caller, and only one of them
 * belongs in sync_log.
 */
export async function getBigshareCompanies(): Promise<BigshareCompany[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.companies;
  if (inFlight) return inFlight;

  inFlight = fetchBigshareCompanies()
    .then((companies) => {
      cached = { companies, expiresAt: Date.now() + CACHE_TTL_MS };
      return companies;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drops the cache. For tests, and for a forced re-scrape. */
export function clearBigshareCompaniesCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Record a resolved match on an `ipos` row.
 *
 * Not filtered on `createdBy: null`, the same documented exemption
 * `saveKfintechMatch` and `saveMufgMatch` take and for the same reason: only
 * these four additive fields are ever written, never anything a user typed, so a
 * manually-added IPO can still acquire a working "Check status" button.
 */
export async function saveBigshareMatch(ipoId: string, clientId: string): Promise<void> {
  await prisma.ipo.update({
    where: { id: ipoId },
    data: {
      registrar: BIGSHARE_REGISTRAR,
      registrarUrl: BIGSHARE_STATUS_URL,
      registrarCompanyId: clientId,
      registrarKey: 'BIGSHARE',
    },
  });
}

/**
 * Resolve one IPO's Bigshare company id on demand and persist it.
 *
 * Returns null rather than throwing on any failure — an outage at Bigshare must
 * degrade a check to "no match yet", not become an error the user has to
 * interpret. Same contract as resolveKfintechCompanyId and resolveMufgCompanyId.
 */
export async function resolveBigshareCompanyId(
  ipoId: string,
  companyName: string,
): Promise<string | null> {
  try {
    const match = matchCompanyByName(companyName, await getBigshareCompanies());
    if (!match) return null;
    await saveBigshareMatch(ipoId, match.clientId);
    return match.clientId;
  } catch {
    return null;
  }
}

/**
 * Ask Bigshare what it holds against this PAN for this issue. Returns the parsed
 * JSON body; `parseBigshareAllotment` decides what it means.
 *
 * The body is hand-built rather than JSON.stringify'd because their page sends
 * unquoted keys and single-quoted values — ASP.NET's WebMethod deserialiser
 * accepts it, and sending the same bytes their own page sends is the cheapest
 * insurance against a future strictness change. The fields we do not use are
 * still present and empty, exactly as their form submits them.
 */
export async function searchBigshareByPan(clientId: string, pan: string): Promise<unknown> {
  // Their handler concatenates these into the payload with no escaping. A
  // clientId comes from our own scrape of their dropdown and a PAN from
  // demat_accounts, so neither should carry a quote — but a stray one would
  // corrupt the request rather than error, so refuse instead.
  if (/['"\\]/.test(clientId) || /['"\\]/.test(pan)) {
    throw new Error('Bigshare query rejected: client id or PAN contains a quote');
  }

  const body =
    `{ Applicationno: '',Company: '${clientId}',SelectionType: '${BIGSHARE_MODE_PAN}',` +
    `PanNo: '${pan}', txtcsdl: '', txtDPID: '',txtClId: '',ddlType:'0',lang: 'en'}`;

  const res = await fetch(`${BIGSHARE_BASE}/Data.aspx/FetchIpodetails`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json; charset=UTF-8',
      Origin: BIGSHARE_BASE,
      // Their WebMethod is a same-origin XHR; sending the page it belongs to
      // keeps the request shaped like the one their site makes.
      Referer: BIGSHARE_STATUS_URL,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  if (res.status === 429) throw new Error('Bigshare is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`Bigshare allotment check responded ${res.status}`);

  return res.json().catch(() => null);
}
