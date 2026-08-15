/**
 * MUFG Intime's responses, and what we read out of them.
 *
 * Provenance of the fixtures, because it decides how much they are worth:
 *
 *   - COMPANIES and EMPTY are verbatim captures from live calls on 2026-08-15
 *     (GetDetails, and SearchOnPan for a PAN with no application in that issue).
 *     `<NewDataSet />` really is the whole body in the second case.
 *   - ALLOTTED is reconstructed from MUFG's own render function, `onDataBindPAN`
 *     in public-issues.html, which is the only specification of the row shape
 *     that exists. It could not be captured live: the one issue we hold
 *     applications for that MUFG registers, Behari Lal Engineering, does not
 *     publish its basis of allotment until 2026-08-17, and until then the issue
 *     is not even in their dropdown. Re-capture it then and replace this.
 */
import {
  MUFG_MODE_PAN,
  mufgEnvelope,
  mufgMessage,
  parseMufgAllotment,
  parseMufgCompanies,
} from './mufg.parse.js';

// --- fixtures --------------------------------------------------------------

/** GetDetails, live 2026-08-15. */
const COMPANIES = `<NewDataSet>\r\n  <Table>\r\n    <company_id>11921</company_id>\r\n    <companyname>Leap India Limited - IPO</companyname>\r\n  </Table>\r\n  <Table>\r\n    <company_id>11919</company_id>\r\n    <companyname>Poojaa Precision Engg. Limited - SME IPO</companyname>\r\n  </Table>\r\n</NewDataSet>`;

/** SearchOnPan for a PAN with no application in that issue, live 2026-08-15. */
const EMPTY = '<NewDataSet />';

/** Reconstructed — see the header. */
const ALLOTTED = `<NewDataSet>
  <Table>
    <PEMNDG>12345678</PEMNDG>
    <NAME1>RAVI KUMAR</NAME1>
    <SHARES>1,050</SHARES>
    <ALLOT>150</ALLOT>
    <offer_price>210</offer_price>
    <AMTADJ>31500</AMTADJ>
    <RFNDAMT>189000</RFNDAMT>
    <INVCODE>91</INVCODE>
    <BNKCODE>0</BNKCODE>
    <InvestorEmail>r***@example.com</InvestorEmail>
  </Table>
</NewDataSet>`;

const MESSAGE = `<NewDataSet>
  <Table1>
    <Msg>No records found for the given PAN.</Msg>
  </Table1>
</NewDataSet>`;

// --- the envelope ----------------------------------------------------------

describe('mufgEnvelope', () => {
  it('unwraps the XML string every WebMethod nests inside JSON', () => {
    expect(mufgEnvelope({ d: '<NewDataSet />' })).toBe('<NewDataSet />');
  });

  it('accepts the bare nonce generateToken returns', () => {
    expect(mufgEnvelope({ d: '924649117' })).toBe('924649117');
  });

  it('refuses anything that is not a non-empty string', () => {
    expect(mufgEnvelope({ d: '' })).toBeNull();
    expect(mufgEnvelope({ d: 42 })).toBeNull();
    expect(mufgEnvelope({})).toBeNull();
    expect(mufgEnvelope(null)).toBeNull();
  });
});

// --- the dropdown ----------------------------------------------------------

describe('parseMufgCompanies', () => {
  it('reads the dropdown and strips the issue-type suffix', () => {
    expect(parseMufgCompanies(COMPANIES)).toEqual([
      { clientId: '11921', name: 'Leap India Limited' },
      // "- SME IPO" goes too: left in, "sme" would score against every SME
      // issue at once.
      { clientId: '11919', name: 'Poojaa Precision Engg. Limited' },
    ]);
  });

  it('returns nothing rather than throwing on an empty or broken document', () => {
    expect(parseMufgCompanies(EMPTY)).toEqual([]);
    expect(parseMufgCompanies('<NewDataSet><Table><company_id>1</company_id></Table>')).toEqual([]);
    expect(parseMufgCompanies('not xml at all')).toEqual([]);
  });
});

// --- the allotment result --------------------------------------------------

describe('parseMufgAllotment', () => {
  it('reads an allotted application', () => {
    expect(parseMufgAllotment(ALLOTTED)).toEqual([
      {
        applicationNo: '12345678',
        dpClientId: null,
        applicantName: 'RAVI KUMAR',
        // Their numbers arrive comma-grouped.
        sharesApplied: 1050,
        sharesAllotted: 150,
      },
    ]);
  });

  it('treats the empty DataSet as "nothing on file yet", not as an error', () => {
    expect(parseMufgAllotment(EMPTY)).toBeNull();
  });

  it('treats a Msg row the same way, so a no-result never reads as NOT_ALLOTTED', () => {
    expect(parseMufgAllotment(MESSAGE)).toBeNull();
  });

  it('drops a row carrying none of the facts we came for', () => {
    expect(parseMufgAllotment('<NewDataSet><Table><offer_price>210</offer_price></Table></NewDataSet>')).toBeNull();
  });

  it('defaults a missing allotment to zero rather than dropping the row', () => {
    const xml = '<NewDataSet><Table><PEMNDG>99</PEMNDG><SHARES>100</SHARES></Table></NewDataSet>';
    expect(parseMufgAllotment(xml)).toEqual([
      {
        applicationNo: '99',
        dpClientId: null,
        applicantName: null,
        sharesApplied: 100,
        sharesAllotted: 0,
      },
    ]);
  });

  it('survives malformed XML instead of throwing', () => {
    expect(parseMufgAllotment('<NewDataSet><Table>')).toBeNull();
    expect(parseMufgAllotment('')).toBeNull();
  });
});

describe('mufgMessage', () => {
  it('surfaces the complaint MUFG puts in Table1', () => {
    expect(mufgMessage(MESSAGE)).toBe('No records found for the given PAN.');
  });

  it('decodes the entities a .NET DataSet escapes', () => {
    expect(mufgMessage('<NewDataSet><Table1><Msg>A &amp; B &lt;x&gt;</Msg></Table1></NewDataSet>')).toBe(
      'A & B <x>',
    );
  });

  it('is null when there is no message', () => {
    expect(mufgMessage(EMPTY)).toBeNull();
    expect(mufgMessage(ALLOTTED)).toBeNull();
  });
});

describe('MUFG_MODE_PAN', () => {
  // Their CHKVAL switch: 1 PAN, 2 application no, 3 DPID/CLID, 4 account no.
  // Sending the wrong one silently searches the wrong column.
  it('is their PAN mode', () => {
    expect(MUFG_MODE_PAN).toBe('1');
  });
});
