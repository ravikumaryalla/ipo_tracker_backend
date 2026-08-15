/**
 * The app's "Check status" button, and the whole of it.
 *
 * `/check` asks whichever registrar handles each application's issue — KFintech,
 * MUFG Intime or Bigshare; checkAllotments.ts routes it, resolving the issue's
 * company id against each registrar's own list on the way if it has none yet.
 *
 * There used to be a second endpoint here, `/sync-kfintech`, because the client
 * pre-checked for a `kfintech_company_id` before it was willing to call `/check`
 * at all. That gate is gone: it could only ever be satisfied by KFintech, so it
 * silently disabled the button for every MUFG issue and would have done the same
 * for every Bigshare one. The client now always calls `/check` and lets the
 * resolution happen here, where all three lists are.
 *
 * This was an Edge Function invocation before. The ownership check that
 * `check-allotments` had to do by hand — build a second Supabase client from the
 * caller's JWT, resolve the user, filter the requested ids — is now just the
 * `userId` argument below, because nothing here runs with a RLS-bypassing key in
 * the first place.
 */
import { Router } from 'express';
import { z } from 'zod';

import { checkApplications } from '../jobs/checkAllotments.js';
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
