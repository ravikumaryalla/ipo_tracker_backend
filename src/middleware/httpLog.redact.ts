/**
 * What the payload log is allowed to print — split from httpLog.ts, and free of
 * any import that touches env or the database, so it can be tested directly the
 * way the scrapers' `*.parse.ts` modules are.
 *
 * REDACTED BY KEY, NOT BY ROUTE: these endpoints carry plaintext passwords, both
 * JWTs, PANs and the entire encrypted vault — `POST /accounts/reencrypt` posts
 * every ciphertext field the user has. A route-based rule would need updating
 * every time a field moves; a key rule follows the field wherever it turns up,
 * including nested inside `enc` and inside the `history` and `accounts` arrays.
 *
 * Redaction keeps the shape. A secret string becomes `[redacted N chars]` and a
 * null stays null: "absent" and "present but secret" are a real distinction when
 * you are debugging why a PATCH did not take, and collapsing them would throw
 * away the one thing the log was opened for.
 */

/** Exact key matches. */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'pan',
  'secret',
]);

/**
 * `_enc` covers all ten vault columns plus pan_enc and old_value_enc (see
 * ENC_COLUMNS in routes/accounts.ts); `vault_` covers the profile's salt,
 * verifier and recovery blob.
 */
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.has(k) || k.endsWith('_enc') || k.startsWith('vault_');
}

/** Only a string carries the secret; a null or a number under the same key does not. */
function redactValue(value: unknown): unknown {
  return typeof value === 'string' ? `[redacted ${value.length} chars]` : value;
}

/**
 * A copy of `value` with every sensitive string replaced. Never mutates the
 * input — the real `req.body` goes on to be parsed by the route handler.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? redactValue(v) : redact(v);
    }
    return out;
  }

  return value;
}

/**
 * `GET /push-tokens?token=…` carries a real Expo push token, so the query string
 * gets the same treatment as a body before the URL is printed.
 */
export function redactUrl(url: string): string {
  const [path, query] = url.split('?', 2);
  if (!query) return url;

  // Rebuilt by hand rather than with URLSearchParams.toString(), which
  // percent-encodes the value and renders the marker's spaces as '+'. This
  // string is read by a person and never sent anywhere, so it stays decoded.
  const rendered = [...new URLSearchParams(query).entries()].map(
    ([key, value]) =>
      `${key}=${isSensitiveKey(key) ? `[redacted ${value.length} chars]` : value}`,
  );

  return `${path}?${rendered.join('&')}`;
}
