import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

import { env } from '../env.js';
import { unauthorized } from '../errors.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Guards the scraper endpoints, which run with no user and write shared data.
 * These replace the pg_cron + service-role-key path; the secret is held only by
 * the external scheduler.
 */
export const requireJobSecret: RequestHandler = (req, _res, next) => {
  const presented = req.header('x-job-secret');
  if (!presented || !safeEqual(presented, env.JOB_SECRET)) {
    next(unauthorized('invalid_job_secret', 'Invalid job secret.'));
    return;
  }
  next();
};
