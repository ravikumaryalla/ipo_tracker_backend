/**
 * Bigshare's parsing, against the shapes their live site actually returns.
 *
 * Every fixture below is trimmed from a real 2026-08-15 response — the company
 * dropdown from ipo_status.html and a FetchIpodetails body for a real PAN — so
 * these tests fail if Bigshare changes shape rather than only if we do.
 */
import { parseBigshareAllotment, parseBigshareCompanies } from './bigshare.parse.js';

/**
 * The dropdown as served: one live option, the rest inside comment blocks, and
 * a valueless "--Select Company--" sentinel. The tabs and ragged indentation are
 * theirs and are left in on purpose.
 */
const DROPDOWN = `
  <div class="from-group">
    <select id="ddlCompany">
      <option>--Select Company--</option>
			<option value="9043">TECHNOCRAFT VENTURES LIMITED</option>
			<!-- <option value="587">ANAWIL WIRE AND ENGINEERING LIMITED</option>
			<option value="586">METALIC TECHNOFORGE LIMITED</option> -->
			<!-- <option value="9041">AASTHA SPINTEX LIMITED</option> -->
			<!--<option value="582">JIVIAL INDUSTRIES LIMITED</option>
			<option value="9024">SHANTI GOLD INTERNATIONAL LTD</option>-->
    </select>
    <label id="lblComp"></label>
  </div>
`;

describe('parseBigshareCompanies', () => {
  it('reads the live option', () => {
    expect(parseBigshareCompanies(DROPDOWN)[0]).toEqual({
      clientId: '9043',
      name: 'TECHNOCRAFT VENTURES LIMITED',
      archived: false,
    });
  });

  // The whole reason this parser is not three lines. 89 of the 90 entries on
  // the day this was written were commented out, including every issue whose
  // allotment had already been published — the exact ones a user taps "Check
  // status" for. Their ids still answer FetchIpodetails.
  it('reads options out of the commented-out blocks too', () => {
    const byId = new Map(parseBigshareCompanies(DROPDOWN).map((c) => [c.clientId, c]));

    expect(byId.get('586')).toEqual({
      clientId: '586',
      name: 'METALIC TECHNOFORGE LIMITED',
      archived: true,
    });
    // Spans several separate comment blocks, including a `<!--<option` with no
    // space after the delimiter.
    expect([...byId.keys()]).toEqual(['9043', '587', '586', '9041', '582', '9024']);
  });

  it('puts live entries first, so a name in both wins as the live one', () => {
    const both = parseBigshareCompanies(`
      <select id="ddlCompany">
        <option value="9043">TECHNOCRAFT VENTURES LIMITED</option>
        <!-- <option value="4300">TECHNOCRAFT VENTURES LIMITED</option> -->
      </select>
    `);
    expect(both.map((c) => c.clientId)).toEqual(['9043', '4300']);
    expect(both[0].archived).toBe(false);
  });

  it('skips the valueless "--Select Company--" sentinel', () => {
    expect(parseBigshareCompanies(DROPDOWN).map((c) => c.name)).not.toContain(
      '--Select Company--',
    );
  });

  it('returns nothing when the select is gone, rather than guessing', () => {
    expect(parseBigshareCompanies('<html><body>maintenance</body></html>')).toEqual([]);
  });

  it('does not pick up options from other selects on the page', () => {
    const withLanguages = `
      <select id="ddllang"><option value="1">ENGLISH</option></select>
      ${DROPDOWN}
      <select id="SelectionType"><option value="2">PAN Number</option></select>
    `;
    expect(parseBigshareCompanies(withLanguages).map((c) => c.clientId)).not.toContain('1');
    expect(parseBigshareCompanies(withLanguages).map((c) => c.clientId)).not.toContain('2');
  });
});

describe('parseBigshareAllotment', () => {
  /** A real response, PAN redacted. Note ALLOTED is a string, not a number. */
  const NOT_ALLOTTED = {
    d: {
      __type: 'Data+Company',
      APPLICATION_NO: '2608111206508708',
      DPID: '1208940001869634',
      Name: 'MR. A B EXAMPLE',
      APPLIED: '70',
      ALLOTED: 'NON-ALLOTTE',
      H_APPLICATION_NO: 'Application No',
      H_DPID: 'DP ID/CL ID or Folio',
      H_Name: 'NAME',
      H_APPLIED: 'Applied',
      H_ALLOTED: 'Alloted',
    },
  };

  it('maps a real response onto one AllotmentMatch', () => {
    expect(parseBigshareAllotment(NOT_ALLOTTED)).toEqual([
      {
        applicationNo: '2608111206508708',
        dpClientId: '1208940001869634',
        applicantName: 'MR. A B EXAMPLE',
        sharesApplied: 70,
        sharesAllotted: 0,
      },
    ]);
  });

  // The single most dangerous field on this path. "NON-ALLOTTE" through a plain
  // Number() is NaN, and NaN fails `sharesAllotted <= 0` in statusFor — so a
  // rejected application would be reported to the user as ALLOTTED.
  it.each(['NON-ALLOTTE', 'NON-ALLOTTED', '', '  ', 'N.A.'])(
    'treats a non-numeric ALLOTED (%s) as zero shares, never NaN',
    (alloted) => {
      const [match] = parseBigshareAllotment({ d: { ...NOT_ALLOTTED.d, ALLOTED: alloted } })!;
      expect(match.sharesAllotted).toBe(0);
    },
  );

  it('reads a real allotment, commas and all', () => {
    const [match] = parseBigshareAllotment({
      d: { ...NOT_ALLOTTED.d, APPLIED: '1,400', ALLOTED: '1,400' },
    })!;
    expect(match).toMatchObject({ sharesApplied: 1400, sharesAllotted: 1400 });
  });

  // Their "not out yet" is a 200 carrying this sentinel, so the status code
  // cannot be used to tell it from a real answer.
  it('reads "No data found" as nothing on file yet', () => {
    expect(
      parseBigshareAllotment({
        d: {
          __type: 'Data+Company',
          APPLICATION_NO: '',
          DPID: 'No data found',
          Name: '',
          APPLIED: '',
          ALLOTED: '',
        },
      }),
    ).toBeNull();
  });

  it.each([null, undefined, {}, { d: null }, { d: 'unexpected' }])(
    'reads a missing or malformed envelope (%p) as nothing on file',
    (body) => {
      expect(parseBigshareAllotment(body)).toBeNull();
    },
  );

  // A row with none of the three facts we came for is a shape change. Reporting
  // it would mark a real application NOT_ALLOTTED on the strength of nothing.
  it('refuses a row carrying no application, name or applied count', () => {
    expect(
      parseBigshareAllotment({ d: { APPLICATION_NO: '', Name: '', APPLIED: '', ALLOTED: '' } }),
    ).toBeNull();
  });
});
