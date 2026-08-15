/**
 * The small routes: brokers, sync status, the caller's profile, push tokens.
 */
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { asyncHandler } from '../util/asyncHandler.js';
import { brokerRow, profileRow, pushTokenRow, syncLogRow } from '../wire.js';

export const miscRouter = Router();
miscRouter.use(requireAuth);

/** Shared reference data — seeded by migration, read-only to everyone. */
miscRouter.get(
  '/brokers',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.broker.findMany({ orderBy: { name: 'asc' } });
    res.json(rows.map(brokerRow));
  }),
);

/**
 * Most recent sync attempt per provider, so the app can say *why* the list
 * looks stale instead of silently showing old data.
 *
 * Nine providers report per run, so 45 rows is roughly five runs — enough to
 * still name a provider that failed a couple of runs ago.
 */
miscRouter.get(
  '/sync-status',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.syncLog.findMany({ orderBy: { ranAt: 'desc' }, take: 45 });

    const seen = new Set<string>();
    const latest = rows.filter((row) => {
      if (seen.has(row.provider)) return false;
      seen.add(row.provider);
      return true;
    });

    res.json(latest.map(syncLogRow));
  }),
);

miscRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const row = await prisma.profile.findUnique({ where: { id: userId(req) } });
    if (!row) throw notFound('not_found', 'Profile not found.');
    res.json(profileRow(row));
  }),
);

/**
 * Vault crypto material. The salt and verifier are public by design — the
 * passphrase they derive from never leaves the device — so accepting them here
 * gives the server nothing it could decrypt with.
 */
const profilePatch = z.object({
  display_name: z.string().nullable().optional(),
  vault_salt: z.string().nullable().optional(),
  vault_verifier: z.string().nullable().optional(),
  vault_recovery_blob: z.string().nullable().optional(),
  auto_lock_minutes: z.number().int().min(0).max(1440).optional(),
});

miscRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = profilePatch.parse(req.body);
    const row = await prisma.profile.update({
      where: { id: userId(req) },
      data: {
        ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
        ...(body.vault_salt === undefined ? {} : { vaultSalt: body.vault_salt }),
        ...(body.vault_verifier === undefined ? {} : { vaultVerifier: body.vault_verifier }),
        ...(body.vault_recovery_blob === undefined
          ? {}
          : { vaultRecoveryBlob: body.vault_recovery_blob }),
        ...(body.auto_lock_minutes === undefined
          ? {}
          : { autoLockMinutes: body.auto_lock_minutes }),
      },
    });
    res.json(profileRow(row));
  }),
);

/** One row per device: an account can have the app on more than one phone. */
miscRouter.post(
  '/push-tokens',
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(1) }).parse(req.body);
    const uid = userId(req);

    const row = await prisma.pushToken.upsert({
      where: { userId_token: { userId: uid, token: body.token } },
      create: { userId: uid, token: body.token },
      update: {},
    });
    res.json(pushTokenRow(row));
  }),
);

miscRouter.get(
  '/push-tokens',
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.query);
    const row = await prisma.pushToken.findUnique({
      where: { userId_token: { userId: userId(req), token } },
    });
    res.json({ exists: row !== null });
  }),
);

miscRouter.delete(
  '/push-tokens',
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(1) }).parse(req.body);
    await prisma.pushToken.deleteMany({ where: { userId: userId(req), token: body.token } });
    res.status(204).end();
  }),
);
