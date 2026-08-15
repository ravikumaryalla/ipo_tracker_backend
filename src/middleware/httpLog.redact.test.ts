/**
 * The payload redactor.
 *
 * The bodies below are the real shapes the routes accept and return, not
 * invented ones: the account patch is `updateSchema` from routes/accounts.ts,
 * the reencrypt body is what a change-PIN rotation posts, and the session is
 * what services/auth.ts returns from a login. If one of those shapes grows a
 * secret field, the test that should fail is the one carrying that shape.
 */
import { redact, redactUrl } from './httpLog.redact.js';

describe('redact', () => {
  it('replaces a password with its length', () => {
    expect(redact({ email: 'a@b.com', password: 'hunter2!!!!' })).toEqual({
      email: 'a@b.com',
      password: '[redacted 11 chars]',
    });
  });

  it('replaces both tokens in a session response', () => {
    const session = {
      access_token: 'x'.repeat(213),
      refresh_token: 'y'.repeat(64),
      expires_in: 900,
      user: { id: '3f9a', email: 'a@b.com' },
    };

    expect(redact(session)).toEqual({
      access_token: '[redacted 213 chars]',
      refresh_token: '[redacted 64 chars]',
      expires_in: 900,
      user: { id: '3f9a', email: 'a@b.com' },
    });
  });

  it('walks the nested enc object and the history array of an account patch', () => {
    const patch = {
      nickname: 'Zerodha main',
      pan: 'ABCDE1234F',
      is_active: true,
      enc: { password_enc: 'c'.repeat(184), mpin_enc: null },
      history: [{ field: 'password', old_value_enc: 'd'.repeat(184) }],
    };

    expect(redact(patch)).toEqual({
      nickname: 'Zerodha main',
      pan: '[redacted 10 chars]',
      is_active: true,
      enc: { password_enc: '[redacted 184 chars]', mpin_enc: null },
      history: [{ field: 'password', old_value_enc: '[redacted 184 chars]' }],
    });
  });

  it('walks an array of accounts, as POST /accounts/reencrypt sends', () => {
    const body = {
      accounts: [
        { id: 'a1', enc: { upi_id_enc: 'e'.repeat(40) }, pan_enc: 'f'.repeat(60) },
        { id: 'a2', enc: { upi_id_enc: null }, pan_enc: null },
      ],
    };

    expect(redact(body)).toEqual({
      accounts: [
        { id: 'a1', enc: { upi_id_enc: '[redacted 40 chars]' }, pan_enc: '[redacted 60 chars]' },
        { id: 'a2', enc: { upi_id_enc: null }, pan_enc: null },
      ],
    });
  });

  it('replaces the profile vault fields', () => {
    expect(
      redact({
        display_name: 'Ravi',
        vault_salt: 's'.repeat(24),
        vault_verifier: 'v'.repeat(88),
        vault_recovery_blob: null,
        auto_lock_minutes: 5,
      }),
    ).toEqual({
      display_name: 'Ravi',
      vault_salt: '[redacted 24 chars]',
      vault_verifier: '[redacted 88 chars]',
      vault_recovery_blob: null,
      auto_lock_minutes: 5,
    });
  });

  it('leaves ordinary fields of an application alone', () => {
    const application = {
      ipo_id: '9d2e',
      demat_account_id: '7c1b',
      category: 'RETAIL',
      lots: 2,
      bid_price: 210,
      notes: null,
    };
    expect(redact(application)).toEqual(application);
  });

  it('passes non-string values under a sensitive key straight through', () => {
    // "absent" and "present but secret" have to stay distinguishable.
    expect(redact({ pan: null, token: undefined, password_enc: false })).toEqual({
      pan: null,
      token: undefined,
      password_enc: false,
    });
  });

  it('does not mutate the input — the handler still has to parse the real body', () => {
    const body = { password: 'hunter2', enc: { pan_enc: 'abc' } };
    redact(body);
    expect(body).toEqual({ password: 'hunter2', enc: { pan_enc: 'abc' } });
  });

  it('handles a bare array body and primitives', () => {
    expect(redact([{ pan: 'ABCDE1234F' }])).toEqual([{ pan: '[redacted 10 chars]' }]);
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
  });
});

describe('redactUrl', () => {
  it('replaces a push token in the query string', () => {
    expect(redactUrl('/push-tokens?token=ExponentPushToken[abcdefghij]')).toBe(
      '/push-tokens?token=[redacted 29 chars]',
    );
  });

  it('leaves an ordinary query and a bare path untouched', () => {
    expect(redactUrl('/ipos/9d2e/gmp?limit=120')).toBe('/ipos/9d2e/gmp?limit=120');
    expect(redactUrl('/accounts/raw')).toBe('/accounts/raw');
  });
});
