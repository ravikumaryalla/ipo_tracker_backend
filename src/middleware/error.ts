import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../errors.js';
import { env } from '../env.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
};

/**
 * Postgres constraint violations the app is expected to recognise.
 *
 * `ipo_applications_unique_bid` is load-bearing: the client turns it into
 * "You have already applied from this account in this category" rather than a
 * raw database error, and has done so since the Supabase days by matching on
 * code 23505. Keep that code reachable.
 */
function fromPrisma(err: Prisma.PrismaClientKnownRequestError): AppError | null {
  switch (err.code) {
    case 'P2002':
      return new AppError(409, '23505', `Duplicate value for ${describeTarget(err)}`);
    case 'P2003':
      return new AppError(400, '23503', 'Referenced row does not exist');
    case 'P2025':
      return new AppError(404, 'not_found', 'Not found');
    default:
      return null;
  }
}

function describeTarget(err: Prisma.PrismaClientKnownRequestError): string {
  const target = (err.meta as { target?: string[] | string } | undefined)?.target;
  if (Array.isArray(target)) return target.join(', ');
  return target ?? 'a unique constraint';
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    res.status(400).json({
      error: { code: 'invalid_request', message: `${where}${first?.message ?? 'Invalid request body'}` },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = fromPrisma(err);
    if (mapped) {
      res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
      return;
    }
  }

  // Anything reaching here is a bug, not a client error. Log it in full, but
  // never let the detail (which can include SQL and row contents) leave the
  // server.
  console.error('[unhandled]', err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: env.NODE_ENV === 'development' ? String(err) : 'Something went wrong on our end.',
    },
  });
};
