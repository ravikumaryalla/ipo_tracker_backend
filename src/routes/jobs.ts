/**
 * The scrapers, exposed as endpoints for an external scheduler.
 *
 * This replaces pg_cron + pg_net calling Supabase Edge Functions with the
 * service-role key. The cadences the schedule should use, unchanged from
 * supabase/migrations/*_cron.sql:
 *
 *   sync-ipos          0 4 * * *    (09:30 IST)
 *   sync-ipos          30 13 * * *  (19:00 IST)
 *   check-allotments   *\/15 * * * *
 *
 * Both jobs already record their own outcome in sync_log and are written to
 * degrade rather than throw, so the HTTP status here is for the scheduler's
 * benefit — a non-2xx means "this run is worth alerting on".
 */
import { Router } from 'express';

import { sweepAllotments } from '../jobs/checkAllotments.js';
import { syncIpos } from '../jobs/syncIpos.js';
import { requireJobSecret } from '../middleware/jobAuth.js';
import { asyncHandler } from '../util/asyncHandler.js';

export const jobsRouter = Router();
jobsRouter.use(requireJobSecret);

jobsRouter.post(
  '/sync-ipos',
  asyncHandler(async (_req, res) => {
    const result = await syncIpos();
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

jobsRouter.post(
  '/check-allotments',
  asyncHandler(async (_req, res) => {
    const result = await sweepAllotments();
    res.status(result.ok ? 200 : 502).json(result);
  }),
);
