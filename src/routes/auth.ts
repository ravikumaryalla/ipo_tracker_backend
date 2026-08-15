import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../env.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { asyncHandler } from '../util/asyncHandler.js';
import * as auth from '../services/auth.js';

export const authRouter = Router();

/**
 * The whole test suite shares one process and one client address, so a limiter
 * meant for real traffic would trip partway through and fail later tests for
 * the wrong reason. Off under NODE_ENV=test only.
 */
const skipInTests = () => env.NODE_ENV === 'test';

/**
 * GoTrue rate-limited these for us. Credential endpoints are the one place an
 * unauthenticated caller can guess, so they keep their own limiter.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: { code: 'rate_limited', message: 'Too many attempts — wait a few minutes and try again.' } },
});

/** Reset emails are the expensive path; keep this tighter than login. */
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: { code: 'email_rate_limited', message: 'Too many reset emails sent. Please try again in an hour.' },
  },
});

const credentials = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

authRouter.post(
  '/signup',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const body = credentials.extend({ display_name: z.string().default('') }).parse(req.body);
    const session = await auth.signUp(body.email, body.password, body.display_name);
    // Supabase returned a user with no session when email confirmation was on.
    // Confirmation is not implemented here, so a signup always yields a session
    // and the client's `needsEmailConfirmation` is always false.
    res.status(201).json(session);
  }),
);

authRouter.post(
  '/login',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const body = credentials.parse(req.body);
    res.json(await auth.signIn(body.email, body.password));
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const body = z.object({ refresh_token: z.string().min(1) }).parse(req.body);
    res.json(await auth.refreshSession(body.refresh_token));
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const body = z.object({ refresh_token: z.string().min(1) }).parse(req.body);
    await auth.signOut(body.refresh_token);
    res.status(204).end();
  }),
);

authRouter.post(
  '/password-reset',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const created = await auth.createPasswordReset(body.email);

    if (created) {
      const link = `${env.PASSWORD_RESET_URL}?token=${created.token}`;
      // TODO: send this over email (Resend/SES) instead of logging it. Until a
      // provider is wired the link is server-side only, which is safe but means
      // resets need an operator.
      console.info(`[password-reset] ${auth.normaliseEmail(body.email)} -> ${link}`);
    }

    // Always 200, whether or not the address is registered — a different
    // response here would let anyone test which emails have accounts.
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password-reset/confirm',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ token: z.string().min(1), password: z.string().min(1) })
      .parse(req.body);
    await auth.confirmPasswordReset(body.token, body.password);
    res.json({ ok: true });
  }),
);

/** Lets the app confirm a stored access token is still good on cold start. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ id: userId(req) });
  }),
);
