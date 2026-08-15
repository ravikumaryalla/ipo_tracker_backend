/**
 * IPO applications and the P&L view.
 *
 * Nothing here is encrypted: how many lots you bid for is not a credential, and
 * keeping it in plain columns is what lets Postgres compute the dashboard in
 * one query instead of the client folding every row.
 */
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { param } from '../util/param.js';
import { asyncHandler } from '../util/asyncHandler.js';
import { applicationRow, pnlRow, type RawPnlRow } from '../wire.js';

export const applicationsRouter = Router();
applicationsRouter.use(requireAuth);

const CATEGORY = z.enum(['RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE', 'POLICYHOLDER']);
const STATUS = z.enum(['APPLIED', 'ALLOTTED', 'PARTIAL', 'NOT_ALLOTTED', 'WITHDRAWN', 'REFUNDED']);

/**
 * The view is read with $queryRaw rather than modelled in Prisma: Prisma's view
 * support is still preview, and the view is the one place we genuinely want raw
 * SQL — it already returns exactly the snake_case shape the app expects.
 */
applicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw<RawPnlRow[]>`
      select * from public.v_application_pnl
      where user_id = ${userId(req)}::uuid
      order by applied_at desc
    `;
    res.json(rows.map(pnlRow));
  }),
);

const createSchema = z.object({
  ipo_id: z.string().uuid(),
  demat_account_id: z.string().uuid(),
  category: CATEGORY,
  lots: z.number().int().positive(),
  bid_price: z.number().positive(),
  /** Lot size at the time of applying — denormalised so history stays correct. */
  lot_size: z.number().int().positive(),
  application_no: z.string().nullable().optional(),
  upi_ref: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

applicationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = createSchema.parse(req.body);

    // Without RLS the FKs alone would happily let someone file an application
    // against another user's demat account, so check ownership explicitly.
    const account = await prisma.dematAccount.findFirst({
      where: { id: body.demat_account_id, userId: uid },
      select: { id: true },
    });
    if (!account) throw notFound('not_found', 'That demat account does not exist.');

    const ipo = await prisma.ipo.findFirst({
      where: { id: body.ipo_id, OR: [{ createdBy: null }, { createdBy: uid }] },
      select: { id: true },
    });
    if (!ipo) throw notFound('not_found', 'That IPO does not exist.');

    // Money blocked = shares × the price bid. For a cut-off bid that is the
    // upper band, which is exactly what the bank blocks.
    const sharesApplied = body.lots * body.lot_size;
    const amountBlocked = new Prisma.Decimal(body.bid_price).mul(sharesApplied);

    try {
      const row = await prisma.ipoApplication.create({
        data: {
          userId: uid,
          ipoId: body.ipo_id,
          dematAccountId: body.demat_account_id,
          category: body.category,
          lots: body.lots,
          bidPrice: new Prisma.Decimal(body.bid_price),
          sharesApplied,
          amountBlocked,
          applicationNo: body.application_no ?? null,
          upiRef: body.upi_ref ?? null,
          notes: body.notes ?? null,
        },
      });
      res.status(201).json(applicationRow(row));
    } catch (err) {
      // The unique index is a SEBI rule, not a bug — say so plainly. The client
      // has matched on this code since the Supabase days.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(
          '23505',
          'That account already has an application in this category for this IPO.',
        );
      }
      throw err;
    }
  }),
);

const updateSchema = z.object({
  status: STATUS,
  shares_allotted: z.number().int().min(0).optional(),
  sell_price: z.number().nullable().optional(),
  sold_at: z.string().nullable().optional(),
});

applicationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = updateSchema.parse(req.body);

    const owned = await prisma.ipoApplication.findFirst({
      where: { id: param(req, 'id'), userId: uid },
      select: { id: true },
    });
    if (!owned) throw notFound();

    const row = await prisma.ipoApplication.update({
      where: { id: param(req, 'id') },
      data: {
        status: body.status,
        ...(body.shares_allotted === undefined ? {} : { sharesAllotted: body.shares_allotted }),
        ...(body.sell_price === undefined
          ? {}
          : { sellPrice: body.sell_price === null ? null : new Prisma.Decimal(body.sell_price) }),
        ...(body.sold_at === undefined
          ? {}
          : { soldAt: body.sold_at === null ? null : new Date(body.sold_at) }),
      },
    });

    res.json(applicationRow(row));
  }),
);

/**
 * Record that a registrar check was attempted, without asserting anything about
 * the outcome. Deliberately separate from the outcome update so that entering a
 * result by hand does not masquerade as a check having run.
 */
applicationsRouter.post(
  '/touch-checked',
  asyncHandler(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
    if (body.ids.length === 0) {
      res.json({ updated: 0 });
      return;
    }

    const { count } = await prisma.ipoApplication.updateMany({
      where: { id: { in: body.ids }, userId: userId(req) },
      data: { allotmentCheckedAt: new Date() },
    });
    res.json({ updated: count });
  }),
);

applicationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.ipoApplication.deleteMany({
      where: { id: param(req, 'id'), userId: userId(req) },
    });
    if (count === 0) throw notFound();
    res.status(204).end();
  }),
);
