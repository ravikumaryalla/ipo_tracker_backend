/**
 * pickMatch/statusFor mirror lib/db/allotment.ts exactly (see parse.ts's
 * header comment for why this is a copy, not an import) — these tests are
 * the same claims, ported alongside the code.
 */
import {
  type AllotmentOutcome,
  isAllotmentCheckDue,
  type KfintechAllotmentMatch,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './checkAllotments.parse.js';

function match(patch: Partial<KfintechAllotmentMatch> = {}): KfintechAllotmentMatch {
  return {
    applicationNo: 'APP1',
    dpClientId: 'DP1',
    applicantName: 'A NAME',
    sharesApplied: 100,
    sharesAllotted: 0,
    ...patch,
  };
}

describe('isAllotmentCheckDue', () => {
  it('is not due before 21:00 IST on allotment_date', () => {
    // 20:59 IST = 15:29 UTC.
    expect(isAllotmentCheckDue('2026-08-17', '2026-08-17T15:29:00.000Z')).toBe(false);
  });

  it('is due at exactly 21:00 IST on allotment_date', () => {
    // 21:00 IST = 15:30 UTC.
    expect(isAllotmentCheckDue('2026-08-17', '2026-08-17T15:30:00.000Z')).toBe(true);
  });

  it('stays due later the same evening', () => {
    // 23:50 IST = 18:20 UTC.
    expect(isAllotmentCheckDue('2026-08-17', '2026-08-17T18:20:00.000Z')).toBe(true);
  });

  it('closes at midnight IST that night', () => {
    // 00:00 IST on the 18th = 18:30 UTC on the 17th.
    expect(isAllotmentCheckDue('2026-08-17', '2026-08-17T18:30:00.000Z')).toBe(false);
  });

  it('does not reopen on a later day, even if still unresolved', () => {
    expect(isAllotmentCheckDue('2026-08-17', '2026-08-19T04:00:00.000Z')).toBe(false);
  });

  it('is false for an unparseable date', () => {
    expect(isAllotmentCheckDue('soon', '2026-08-17T18:00:00.000Z')).toBe(false);
  });
});

describe('parseKfintechAllotmentBody', () => {
  it('maps the live response shape', () => {
    const body = {
      data: [
        { Appln_No: '123', DP_CLID: 'IN300394', Name: 'RAVI', App_Shares: '52', All_Shares: '52' },
      ],
    };
    expect(parseKfintechAllotmentBody(body)).toEqual([
      {
        applicationNo: '123',
        dpClientId: 'IN300394',
        applicantName: 'RAVI',
        sharesApplied: 52,
        sharesAllotted: 52,
      },
    ]);
  });

  it('treats a missing All_Shares as zero, not null — KFintech omits it for a clean non-allotment', () => {
    const body = { data: [{ Appln_No: '123' }] };
    expect(parseKfintechAllotmentBody(body)?.[0].sharesAllotted).toBe(0);
  });

  it('is null when there is nothing on file yet', () => {
    expect(parseKfintechAllotmentBody({ data: [] })).toBeNull();
    expect(parseKfintechAllotmentBody(null)).toBeNull();
    expect(parseKfintechAllotmentBody({})).toBeNull();
  });
});

describe('pickMatch', () => {
  it('returns the only match without needing an application number', () => {
    const only = match();
    expect(pickMatch([only], null)).toBe(only);
  });

  it('picks the match whose application number matches ours', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(pickMatch([a, b], 'APP2')).toBe(b);
  });

  it('refuses to guess between several matches when we have no application number on file', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(() => pickMatch([a, b], null)).toThrow(/more than one application/i);
  });

  it('refuses to guess when our application number matches none of them', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(() => pickMatch([a, b], 'APP3')).toThrow(/more than one application/i);
  });
});

describe('statusFor', () => {
  it('is NOT_ALLOTTED when nothing was allotted', () => {
    const outcome: AllotmentOutcome = statusFor(match({ sharesAllotted: 0 }), 100);
    expect(outcome).toBe('NOT_ALLOTTED');
  });

  it('is ALLOTTED when the full applied quantity came through', () => {
    expect(statusFor(match({ sharesApplied: 100, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
  });

  it('is PARTIAL when fewer shares were allotted than applied', () => {
    expect(statusFor(match({ sharesApplied: 100, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });

  it('falls back to the application record\'s shares_applied when KFintech omits it', () => {
    expect(statusFor(match({ sharesApplied: null, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
    expect(statusFor(match({ sharesApplied: null, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });
});
