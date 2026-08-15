/**
 * IPO reference data. Nothing here is encrypted — it is public market
 * information, and encrypting it would only make it unsearchable.
 *
 * Visibility rule, carried over from the old RLS policy: a row with
 * `created_by = null` is synced/shared and everyone can read it; a row with a
 * `created_by` was typed in by hand and belongs to that user alone. Writes are
 * always restricted to your own manual rows — the sync job owns the rest.
 */
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { param } from '../util/param.js';
import { asyncHandler } from '../util/asyncHandler.js';
import { gmpRow, ipoRow } from '../wire.js';

export const iposRouter = Router();
iposRouter.use(requireAuth);

/** Shared or mine — the read half of the old "ipos: read shared or own" policy. */
const visibleTo = (uid: string): Prisma.IpoWhereInput => ({
  OR: [{ createdBy: null }, { createdBy: uid }],
});

const decimal = (v: number | null | undefined) =>
  v === null || v === undefined ? null : new Prisma.Decimal(v);

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

iposRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.ipo.findMany({
      where: visibleTo(userId(req)),
      orderBy: { openDate: { sort: 'desc', nulls: 'last' } },
    });
    res.json(rows.map(ipoRow));
  }),
);

iposRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.ipo.findFirst({
      where: { id: param(req, 'id'), ...visibleTo(userId(req)) },
    });
    if (!row) throw notFound();
    res.json(ipoRow(row));
  }),
);

/**
 * Grey market premium readings, newest first.
 *
 * The client over-fetches and then narrows to a single provider — two feeds
 * write for the same IPO and they do not agree, so interleaving them would draw
 * one line zig-zagging between two series. That narrowing stays on the client
 * (`pickGmpProvider`), which is pure and unit-tested; this endpoint only has to
 * honour the larger limit it asks for.
 */
iposRouter.get(
  '/:id/gmp',
  asyncHandler(async (req, res) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().positive().max(500).default(120) })
      .parse(req.query);

    const visible = await prisma.ipo.findFirst({
      where: { id: param(req, 'id'), ...visibleTo(userId(req)) },
      select: { id: true },
    });
    if (!visible) throw notFound();

    const rows = await prisma.ipoGmp.findMany({
      where: { ipoId: param(req, 'id') },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });
    res.json(rows.map(gmpRow));
  }),
);

/**
 * The row a rejected insert collided with — by symbol, or by the company key.
 *
 * Raw, because `ipos_company_idx` is an expression index over
 * `public.ipo_name_key(company_name)` and Prisma has no way to express that.
 * `is not distinct from` matches the index's NULLS NOT DISTINCT: two undated
 * rows of one company are the same IPO.
 */
async function findColliding(symbol: string, companyName: string, openDate: Date | null) {
  const hit = await prisma.$queryRaw<{ id: string }[]>`
    select id from public.ipos
    where symbol = ${symbol}
       or (public.ipo_name_key(company_name) = public.ipo_name_key(${companyName})
           and open_date is not distinct from ${openDate}::date)
    limit 1
  `;
  return hit.length === 0 ? null : prisma.ipo.findUnique({ where: { id: hit[0].id } });
}

const manualIpoSchema = z.object({
  symbol: z.string().min(1),
  company_name: z.string().min(1),
  segment: z.enum(['MAINBOARD', 'SME']),
  open_date: z.string().nullable(),
  close_date: z.string().nullable(),
  allotment_date: z.string().nullable(),
  listing_date: z.string().nullable(),
  price_band_min: z.number().nullable(),
  price_band_max: z.number().nullable(),
  lot_size: z.number().int().positive().nullable(),
  registrar: z.string().nullable(),
});

iposRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = manualIpoSchema.parse(req.body);
    try {
      const row = await prisma.ipo.create({
        data: {
          symbol: body.symbol,
          companyName: body.company_name,
          segment: body.segment,
          openDate: date(body.open_date),
          closeDate: date(body.close_date),
          allotmentDate: date(body.allotment_date),
          listingDate: date(body.listing_date),
          priceBandMin: decimal(body.price_band_min),
          priceBandMax: decimal(body.price_band_max),
          lotSize: body.lot_size,
          registrar: body.registrar,
          source: 'MANUAL',
          exchange: 'NSE',
          createdBy: userId(req),
        },
      });
      res.status(201).json(ipoRow(row));
    } catch (err) {
      // One IPO is one row, table-wide — by symbol (ipos_symbol_idx) and by
      // company + open date (ipos_company_idx). Adding one that already exists
      // is not an error to show the user: hand back the row that won and let the
      // client carry on with it. 200 rather than 201, because nothing was made.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await findColliding(body.symbol, body.company_name, date(body.open_date));
        if (existing) {
          res.status(200).json(ipoRow(existing));
          return;
        }
      }
      throw err;
    }
  }),
);

const patchSchema = manualIpoSchema
  .partial()
  .extend({
    status: z.enum(['UPCOMING', 'OPEN', 'CLOSED', 'LISTED', 'WITHDRAWN']).optional(),
    listing_price: z.number().nullable().optional(),
    current_price: z.number().nullable().optional(),
    registrar_url: z.string().nullable().optional(),
  });

iposRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = patchSchema.parse(req.body);

    const existing = await prisma.ipo.findFirst({
      where: { id: param(req, 'id'), ...visibleTo(uid) },
      select: { createdBy: true },
    });
    if (!existing) throw notFound();
    // Synced rows are shared reference data — one user editing them would
    // silently rewrite what everyone else sees, and the next sync would undo it.
    if (existing.createdBy !== uid) {
      throw forbidden('read_only_ipo', 'Synced IPOs cannot be edited.');
    }

    // Renaming onto a symbol that already exists cannot silently fold two rows
    // together the way a create can — the caller asked to edit this specific
    // IPO, and its applications hang off it. Say no instead.
    if (body.symbol !== undefined) {
      const clash = await prisma.ipo.findUnique({
        where: { symbol: body.symbol },
        select: { id: true },
      });
      if (clash && clash.id !== param(req, 'id')) {
        throw conflict('23505', 'Another IPO already uses that symbol.');
      }
    }

    try {
      const row = await prisma.ipo.update({
        where: { id: param(req, 'id') },
        data: {
          ...(body.symbol === undefined ? {} : { symbol: body.symbol }),
          ...(body.company_name === undefined ? {} : { companyName: body.company_name }),
          ...(body.segment === undefined ? {} : { segment: body.segment }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.open_date === undefined ? {} : { openDate: date(body.open_date) }),
          ...(body.close_date === undefined ? {} : { closeDate: date(body.close_date) }),
          ...(body.allotment_date === undefined
            ? {}
            : { allotmentDate: date(body.allotment_date) }),
          ...(body.listing_date === undefined ? {} : { listingDate: date(body.listing_date) }),
          ...(body.price_band_min === undefined
            ? {}
            : { priceBandMin: decimal(body.price_band_min) }),
          ...(body.price_band_max === undefined
            ? {}
            : { priceBandMax: decimal(body.price_band_max) }),
          ...(body.listing_price === undefined
            ? {}
            : { listingPrice: decimal(body.listing_price) }),
          ...(body.current_price === undefined
            ? {}
            : { currentPrice: decimal(body.current_price) }),
          ...(body.lot_size === undefined ? {} : { lotSize: body.lot_size }),
          ...(body.registrar === undefined ? {} : { registrar: body.registrar }),
          ...(body.registrar_url === undefined ? {} : { registrarUrl: body.registrar_url }),
        },
      });

      res.json(ipoRow(row));
    } catch (err) {
      // The company key (name + open date) can collide too, and unlike a create
      // there is nothing sensible to fold into — the caller named this row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('23505', 'Another IPO already has that symbol, or that name and date.');
      }
      throw err;
    }
  }),
);
