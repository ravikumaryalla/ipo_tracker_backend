/**
 * MUFG Intime's allotment-status client — the company dropdown, and the
 * PAN-keyed search behind it.
 *
 * The sibling of kfintechCompanies.ts, deliberately built to the same shape: a
 * TTL cache with in-flight sharing so one "Check status" tap covering twenty
 * applications costs one scrape, failures never cached, and matches persisted
 * onto the `ipos` row so the work is done once per issue rather than once per
 * check.
 *
 * The difference from KFintech is the search itself. KFintech exposes a JSON
 * endpoint that takes a PAN in a header; MUFG wants a nonce fetched, encrypted
 * and handed back with the query:
 *
 *   1. POST IPO.aspx/generateToken → a bare nonce, e.g. "924649117"
 *   2. AES-128-CBC that nonce and base64 it → the `token` field
 *   3. POST IPO.aspx/SearchOnPan with {clientid, PAN, IFSC, CHKVAL, token}
 *
 * The key and IV are the literal ASCII "8080808080808080", hardcoded in their
 * own page's `encVal()`. That is not a secret being defeated — it ships in
 * plain sight in the JavaScript every visitor runs. We are asking the same
 * public question a user asks by typing their PAN into that form, on behalf of
 * the user whose PAN it is.
 *
 * Measured 2026-08-15: the server does not currently validate `token` at all —
 * an empty string, a wrong token and a correct one all return the same result.
 * The step is kept anyway. It costs one round trip, it makes our request
 * identical to the one their own page sends, and the day they start enforcing
 * it is not a day we want to spend debugging.
 *
 * Their page still renders a captcha image but every captcha check in its
 * submit handler is commented out, so no captcha field is sent and
 * CaptchaImage.aspx is never touched. If they re-enable it, SearchOnPan starts
 * answering with a Table1/Msg, which `mufgMessage` surfaces into sync_log
 * rather than passing off as "allotment not released yet".
 */
import { createCipheriv } from 'node:crypto';

import { prisma } from '../db.js';
import {
  MUFG_MODE_PAN,
  type MufgCompany,
  mufgEnvelope,
  parseMufgCompanies,
} from './mufg.parse.js';
import { matchCompanyByName } from './syncIpos.parse.js';

const MUFG_BASE = 'https://in.mpms.mufg.com/Initial_Offer';

export const MUFG_STATUS_URL = `${MUFG_BASE}/public-issues.html`;

/**
 * Spelled exactly as ipogyani.ts's REGISTRARS table spells it. The column is
 * rendered straight into "Check allotment at …" on the IPO screen, so a second
 * spelling would surface as a second registrar.
 */
export const MUFG_REGISTRAR = 'MUFG Intime';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json; charset=utf-8',
  // Their WebMethods are same-origin XHRs; sending the page they belong to
  // keeps the request shaped like the one their site makes.
  Referer: MUFG_STATUS_URL,
};

/** Both halves of the key material, as their page hardcodes them. */
const TOKEN_KEY = Buffer.from('8080808080808080', 'utf8');

/** Same TTL and same reasoning as KFintech's: bursts, not freshness. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { companies: MufgCompany[]; expiresAt: number } | null = null;
let inFlight: Promise<MufgCompany[]> | null = null;

/** One WebMethod call: JSON in, `{"d": "<xml>"}` out, the XML returned raw. */
async function callMufg(method: string, payload: Record<string, string>): Promise<string> {
  const res = await fetch(`${MUFG_BASE}/IPO.aspx/${method}`, {
    method: 'POST',
    headers: BROWSER_HEADERS,
    body: JSON.stringify(payload),
  });
  if (res.status === 429) throw new Error('MUFG Intime is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`MUFG ${method} responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const xml = mufgEnvelope(body);
  if (xml === null) throw new Error(`MUFG ${method} returned no payload`);
  return xml;
}

/**
 * The nonce, encrypted the way their `encVal()` does it: AES-128-CBC, PKCS7,
 * key and IV both "8080808080808080", base64 of the ciphertext.
 */
export function mufgToken(nonce: string): string {
  const cipher = createCipheriv('aes-128-cbc', TOKEN_KEY, TOKEN_KEY);
  return Buffer.concat([cipher.update(nonce, 'utf8'), cipher.final()]).toString('base64');
}

async function fetchMufgCompanies(): Promise<MufgCompany[]> {
  const companies = parseMufgCompanies(await callMufg('GetDetails', {}));
  // Unlike KFintech's list — which carries every issue they have ever handled —
  // this one holds only issues currently open for checking, so an empty list is
  // a real state and not necessarily a broken scrape. It is still treated as a
  // failure: caching "no companies" would leave every check dead for ten
  // minutes after a blip, and a caller cannot tell the two apart anyway.
  if (companies.length === 0) throw new Error('MUFG returned no companies');
  return companies;
}

/**
 * The company list, from cache when it is still warm.
 *
 * Throws on a failed scrape rather than returning an empty list, for the same
 * reason getKfintechCompanies does: "nothing listed" and "the scrape broke" are
 * indistinguishable to a caller, and only one of them belongs in sync_log.
 */
export async function getMufgCompanies(): Promise<MufgCompany[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.companies;
  if (inFlight) return inFlight;

  inFlight = fetchMufgCompanies()
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
export function clearMufgCompaniesCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Record a resolved match on an `ipos` row.
 *
 * Not filtered on `createdBy: null`, the same documented exemption
 * `saveKfintechMatch` takes and for the same reason: only these three additive
 * fields are ever written, never anything a user typed, so a manually-added IPO
 * can still acquire a working "Check status" button.
 */
export async function saveMufgMatch(ipoId: string, clientId: string): Promise<void> {
  await prisma.ipo.update({
    where: { id: ipoId },
    data: {
      registrar: MUFG_REGISTRAR,
      registrarUrl: MUFG_STATUS_URL,
      mufgCompanyId: clientId,
    },
  });
}

/**
 * Resolve one IPO's MUFG company id on demand and persist it.
 *
 * Returns null rather than throwing on any failure — an outage at MUFG must
 * degrade a check to "no match yet", not become an error the user has to
 * interpret. Same contract as resolveKfintechCompanyId.
 */
export async function resolveMufgCompanyId(
  ipoId: string,
  companyName: string,
): Promise<string | null> {
  try {
    const match = matchCompanyByName(companyName, await getMufgCompanies());
    if (!match) return null;
    await saveMufgMatch(ipoId, match.clientId);
    return match.clientId;
  } catch {
    return null;
  }
}

/**
 * Ask MUFG what it holds against this PAN for this issue. Returns the raw XML;
 * `parseMufgAllotment` decides what it means.
 *
 * Two round trips per search, because the nonce is single-use — their own page
 * re-runs `GenToken()` after every result. Batching is therefore impossible and
 * the caller keeps MUFG's concurrency low.
 */
export async function searchMufgByPan(clientId: string, pan: string): Promise<string> {
  const nonce = await callMufg('generateToken', {});
  return callMufg('SearchOnPan', {
    clientid: clientId,
    PAN: pan,
    // Only the account-number mode reads IFSC, but the field is not optional.
    IFSC: '',
    CHKVAL: MUFG_MODE_PAN,
    token: mufgToken(nonce),
  });
}
