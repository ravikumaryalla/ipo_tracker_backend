import type { Request } from 'express';

import { badRequest } from '../errors.js';

/**
 * Express 5 types `req.params[k]` as `string | string[] | undefined`, since a
 * route could declare a repeated or optional segment. None of ours do, so this
 * narrows once instead of at every call site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('invalid_request', `Missing :${name} in the request path.`);
  }
  return value;
}
