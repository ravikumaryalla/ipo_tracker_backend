/**
 * Demat accounts — the vault.
 *
 * The server stores and returns ciphertext and never sees a key. It cannot even
 * tell whether a secret changed: XChaCha20-Poly1305 uses a random nonce, so the
 * same plaintext encrypts to a different string every time. That is why the
 * credential_history entries arrive from the client, which did the comparison
 * with the key it holds — here they are simply written, atomically, alongside
 * the update they describe.
 */
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { param } from '../util/param.js';
import { asyncHandler } from '../util/asyncHandler.js';
import { dematAccountRow } from '../wire.js';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

/** Mirrors SECRET_FIELDS in lib/db/accounts.ts. `pan` is deliberately absent. */
const ENC_COLUMNS = {
  client_id_enc: 'clientIdEnc',
  dp_id_enc: 'dpIdEnc',
  bo_id_enc: 'boIdEnc',
  email_enc: 'emailEnc',
  phone_enc: 'phoneEnc',
  password_enc: 'passwordEnc',
  mpin_enc: 'mpinEnc',
  upi_id_enc: 'upiIdEnc',
  linked_bank_enc: 'linkedBankEnc',
  notes_enc: 'notesEnc',
} as const;

const encPatchSchema = z
  .object(
    Object.fromEntries(
      Object.keys(ENC_COLUMNS).map((k) => [k, z.string().nullable().optional()]),
    ) as Record<keyof typeof ENC_COLUMNS, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
  )
  .default({});

/** Translate the wire's snake_case `*_enc` keys to Prisma field names. */
function encToPrisma(enc: Record<string, string | null | undefined>) {
  const patch: Record<string, string | null> = {};
  for (const [wireKey, prismaKey] of Object.entries(ENC_COLUMNS)) {
    const value = enc[wireKey];
    if (value !== undefined) patch[prismaKey] = value;
  }
  return patch;
}

/** Labels only — safe to serve while the caller's vault is locked. */
accountsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.dematAccount.findMany({
      where: { userId: userId(req) },
      select: {
        id: true,
        brokerId: true,
        nickname: true,
        isActive: true,
        passwordChangedAt: true,
        updatedAt: true,
      },
      orderBy: { nickname: 'asc' },
    });

    res.json(
      rows.map((r) => ({
        id: r.id,
        broker_id: r.brokerId,
        nickname: r.nickname,
        is_active: r.isActive,
        password_changed_at: r.passwordChangedAt?.toISOString() ?? null,
        updated_at: r.updatedAt.toISOString(),
      })),
    );
  }),
);

/**
 * Every full row, ciphertext included. Feeds the change-PIN rotation, which has
 * to re-encrypt each field on the device.
 */
accountsRouter.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const rows = await prisma.dematAccount.findMany({
      where: { userId: userId(req) },
      orderBy: { nickname: 'asc' },
    });
    res.json(rows.map(dematAccountRow));
  }),
);

/**
 * Accounts still holding a legacy encrypted PAN. The one-time move to the plain
 * `pan` column can only happen on a device with the vault key, so the server
 * just reports which rows still need it.
 */
accountsRouter.get(
  '/pan-migration',
  asyncHandler(async (req, res) => {
    const rows = await prisma.dematAccount.findMany({
      where: { userId: userId(req), pan: null, panEnc: { not: null } },
      select: { id: true, panEnc: true },
    });
    res.json(rows.map((r) => ({ id: r.id, pan_enc: r.panEnc })));
  }),
);

accountsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.dematAccount.findFirst({
      where: { id: param(req, 'id'), userId: userId(req) },
    });
    if (!row) throw notFound();
    res.json(dematAccountRow(row));
  }),
);

const createSchema = z.object({
  broker_id: z.string().uuid().nullable(),
  nickname: z.string().min(1),
  is_active: z.boolean().optional(),
  opened_on: z.string().nullable().optional(),
  pan: z.string().nullable().optional(),
  enc: encPatchSchema,
  /** The client sets this when the new account was given a password. */
  password_changed: z.boolean().default(false),
});

accountsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const row = await prisma.dematAccount.create({
      data: {
        userId: userId(req),
        brokerId: body.broker_id,
        nickname: body.nickname,
        isActive: body.is_active ?? true,
        openedOn: body.opened_on ? new Date(body.opened_on) : null,
        passwordChangedAt: body.password_changed ? new Date() : null,
        pan: body.pan || null,
        ...encToPrisma(body.enc),
      },
    });
    res.status(201).json(dematAccountRow(row));
  }),
);

const updateSchema = z.object({
  broker_id: z.string().uuid().nullable().optional(),
  nickname: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  opened_on: z.string().nullable().optional(),
  pan: z.string().nullable().optional(),
  enc: encPatchSchema,
  /**
   * Prior ciphertext for each secret the client determined has changed. Written
   * in the same transaction as the update, so a failure can never leave the new
   * value saved with no way back to the old one.
   */
  history: z
    .array(z.object({ field: z.string().min(1), old_value_enc: z.string().min(1) }))
    .default([]),
  password_changed: z.boolean().default(false),
});

accountsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const id = param(req, 'id');
    const body = updateSchema.parse(req.body);

    const owned = await prisma.dematAccount.findFirst({ where: { id, userId: uid }, select: { id: true } });
    if (!owned) throw notFound();

    const row = await prisma.$transaction(async (tx) => {
      if (body.history.length > 0) {
        await tx.credentialHistory.createMany({
          data: body.history.map((h) => ({
            userId: uid,
            dematAccountId: id,
            field: h.field,
            oldValueEnc: h.old_value_enc,
          })),
        });
      }

      return tx.dematAccount.update({
        where: { id },
        data: {
          ...(body.broker_id === undefined ? {} : { brokerId: body.broker_id }),
          ...(body.nickname === undefined ? {} : { nickname: body.nickname }),
          ...(body.is_active === undefined ? {} : { isActive: body.is_active }),
          ...(body.opened_on === undefined
            ? {}
            : { openedOn: body.opened_on ? new Date(body.opened_on) : null }),
          ...(body.pan === undefined ? {} : { pan: body.pan || null }),
          ...(body.password_changed ? { passwordChangedAt: new Date() } : {}),
          ...encToPrisma(body.enc),
        },
      });
    });

    res.json(dematAccountRow(row));
  }),
);

accountsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.dematAccount.deleteMany({
      where: { id: param(req, 'id'), userId: userId(req) },
    });
    if (count === 0) throw notFound();
    res.status(204).end();
  }),
);

/**
 * Change-PIN rotation: every account's fields, already re-encrypted under the
 * new key on the device. One transaction, because a half-rotated vault would
 * leave some rows readable only under the old key and some only under the new.
 */
accountsRouter.post(
  '/reencrypt',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = z
      .object({
        accounts: z.array(
          z.object({
            id: z.string().uuid(),
            enc: encPatchSchema,
            pan_enc: z.string().nullable().optional(),
          }),
        ),
      })
      .parse(req.body);

    const ids = body.accounts.map((a) => a.id);
    const owned = await prisma.dematAccount.count({ where: { id: { in: ids }, userId: uid } });
    if (owned !== ids.length) throw notFound('not_found', 'One or more accounts do not exist.');

    await prisma.$transaction(
      body.accounts.map((a) =>
        prisma.dematAccount.update({
          where: { id: a.id },
          data: {
            ...encToPrisma(a.enc),
            ...(a.pan_enc === undefined ? {} : { panEnc: a.pan_enc }),
          },
        }),
      ),
    );

    res.json({ rewritten: body.accounts.length });
  }),
);

/** Completes the one-time PAN migration for rows the device could decrypt. */
accountsRouter.post(
  '/pan-migration',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = z
      .object({ accounts: z.array(z.object({ id: z.string().uuid(), pan: z.string().min(1) })) })
      .parse(req.body);

    let migrated = 0;
    for (const a of body.accounts) {
      const { count } = await prisma.dematAccount.updateMany({
        where: { id: a.id, userId: uid },
        data: { pan: a.pan, panEnc: null },
      });
      migrated += count;
    }

    res.json({ migrated });
  }),
);
