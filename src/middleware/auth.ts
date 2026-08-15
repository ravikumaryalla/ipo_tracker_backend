import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

import { env } from '../env.js';
import { unauthorized } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export type AccessTokenClaims = {
  sub: string;
  typ: 'access';
};

export function signAccessToken(userId: string, ttlSeconds: number): string {
  return jwt.sign({ sub: userId, typ: 'access' } satisfies AccessTokenClaims, env.JWT_SECRET, {
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
  });
}

/**
 * Replaces what RLS used to do. Every data route sits behind this, and every
 * query below it filters on `req.userId` — there is no second line of defence
 * in the database any more, so a handler that forgets is a data leak.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('unauthenticated', 'Sign in to continue.'));
    return;
  }

  try {
    const claims = jwt.verify(header.slice('Bearer '.length), env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as AccessTokenClaims;

    // A refresh token must never be usable as a bearer credential.
    if (claims.typ !== 'access' || !claims.sub) {
      next(unauthorized('invalid_token', 'Sign in to continue.'));
      return;
    }

    req.userId = claims.sub;
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    // The client's fetch wrapper refreshes on `token_expired` and signs the
    // user out on anything else, so the distinction matters.
    next(
      unauthorized(
        expired ? 'token_expired' : 'invalid_token',
        expired ? 'Session expired.' : 'Sign in to continue.',
      ),
    );
  }
};

/** Handlers below `requireAuth` always have a user; this makes that typed. */
export function userId(req: { userId?: string }): string {
  if (!req.userId) throw unauthorized('unauthenticated', 'Sign in to continue.');
  return req.userId;
}
