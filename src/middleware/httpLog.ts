/**
 * The debugging payload log: what came in, what went back out.
 *
 * Morgan gives one line per request and no bodies, which is the right default
 * but useless when the question is "what did the client actually send". This
 * prints both payloads, paired by a short request id, and is off unless
 * DEBUG_HTTP says otherwise.
 *
 * What gets hidden, and why, lives in httpLog.redact.ts. Header VALUES are never
 * printed here at all, only presence: `Authorization` and `x-job-secret` are
 * live credentials.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

import { env } from '../env.js';
import { redact, redactUrl } from './httpLog.redact.js';

const body = (payload: unknown): string =>
  JSON.stringify(redact(payload), null, 2)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');

/** Which credentials were presented, without printing either of them. */
function credentials(header: (name: string) => string | undefined): string {
  const parts: string[] = [];
  if (header('authorization')) parts.push('auth: Bearer [redacted]');
  if (header('x-job-secret')) parts.push('x-job-secret present');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export const httpLog: RequestHandler = (req, res, next) => {
  if (!env.debugHttp) {
    next();
    return;
  }

  // Requests overlap — a sync-ipos run takes seconds while others land — so
  // without an id the two halves of a pair cannot be told apart.
  const id = randomUUID().slice(0, 4);
  const startedAt = Date.now();

  console.info(
    `--> #${id} ${req.method} ${redactUrl(req.originalUrl)}${credentials((n) => req.header(n))}`,
  );
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    console.info(body(req.body));
  }

  // Every handler answers with res.json, errorHandler included, so one wrapper
  // catches success and error payloads alike. The 204 paths call .end() and
  // simply never set this.
  let payload: unknown;
  let hasPayload = false;
  const json = res.json.bind(res);
  res.json = (value: unknown) => {
    payload = value;
    hasPayload = true;
    return json(value);
  };

  // 'finish' rather than wrapping res.end: it fires exactly once, after the
  // status line is final.
  res.on('finish', () => {
    const line = `<-- #${id} ${res.statusCode} in ${Date.now() - startedAt}ms${
      hasPayload ? '' : '  (no body)'
    }`;
    if (res.statusCode >= 400) console.warn(line);
    else console.info(line);
    if (hasPayload) console.info(body(payload));
  });

  next();
};
