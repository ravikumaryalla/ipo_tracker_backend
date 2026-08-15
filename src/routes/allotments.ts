/**
 * The app's "Check status" button.
 *
 * `/check` asks whichever registrar handles each application's issue — KFintech
 * or MUFG Intime; checkAllotments.ts routes it. `/sync-kfintech` is narrower
 * than its name suggests only in that MUFG needs no equivalent: its company ids
 * are resolved on demand inside the check itself.
 *
 * Both endpoints were Edge Function invocations before. The ownership check
 * that `check-allotments` had to do by hand — build a second Supabase client
 * from the caller's JWT, resolve the user, filter the requested ids — is now
 * just the `userId` argument below, because nothing here runs with a
 * RLS-bypassing key in the first place.
 */
import { Router } from 'express';
import { z } from 'zod';

import { checkApplications } from '../jobs/checkAllotments.js';
import { syncKfintechOnly } from '../jobs/syncIpos.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { asyncHandler } from '../util/asyncHandler.js';

export const allotmentsRouter = Router();
allotmentsRouter.use(requireAuth);

allotmentsRouter.post(
  '/check',
  asyncHandler(async (req, res) => {
    const body = z
      .object({ applicationIds: z.array(z.string().uuid()).max(200) })
      .parse(req.body);

    const results = await checkApplications(userId(req), body.applicationIds);
    res.json({ ok: true, results });
  }),
);

/**
 * A KFintech re-match for an IPO whose company id has not been resolved yet.
 * Scrapes only public data — no PAN, no user rows — so any signed-in caller may
 * trigger it, exactly as the `{ onlyKfintech: true }` Edge Function branch did.
 */
allotmentsRouter.post(
  '/sync-kfintech',
  asyncHandler(async (_req, res) => {
    const result = await syncKfintechOnly();
    res.status(result.ok ? 200 : 502).json(result);
  }),
);
