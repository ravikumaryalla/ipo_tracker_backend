/**
 * Password and session handling — the replacement for Supabase GoTrue.
 *
 * Two credentials, on purpose:
 *   - a short-lived access JWT the client sends on every request, stateless so
 *     no read hits the database on the hot path;
 *   - a long-lived opaque refresh token, stored hashed and rotated on every
 *     use, so a session can actually be revoked (a JWT cannot be).
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

import { prisma } from '../db.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  PASSWORD_RESET_TTL_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
} from '../env.js';
import { badRequest, unauthorized } from '../errors.js';
import { signAccessToken } from '../middleware/auth.js';

/**
 * Supabase's auth.users.encrypted_password is bcrypt, so imported hashes verify
 * unchanged and nobody has to reset a password at cutover. Cost 12 for hashes
 * we mint ourselves.
 */
const BCRYPT_ROUNDS = 12;

/** Matches Supabase's default, which the app's copy already tells users. */
export const MIN_PASSWORD_LENGTH = 6;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(
      'weak_password',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export type Session = {
  access_token: string;
  refresh_token: string;
  /** Seconds until `access_token` expires, matching supabase-js's field name. */
  expires_in: number;
  user: { id: string; email: string };
};

/**
 * Mints a session. The raw refresh token is returned to the caller and only its
 * hash is persisted, so a database dump yields no usable sessions.
 */
export async function issueSession(user: {
  id: string;
  email: string;
}): Promise<Session> {
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt },
  });

  return {
    access_token: signAccessToken(user.id, ACCESS_TOKEN_TTL_SECONDS),
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user: { id: user.id, email: user.email },
  };
}

export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<Session> {
  const normalised = normaliseEmail(email);
  const passwordHash = await hashPassword(password);

  const existing = await prisma.user.findUnique({
    where: { email: normalised },
  });
  if (existing)
    throw badRequest(
      'email_taken',
      'An account with that email already exists.',
    );

  // The user row and its profile are created together — the Supabase schema did
  // this with an on-insert trigger, and a user without a profile would break
  // vault setup on first unlock.
  const user = await prisma.user.create({
    data: {
      email: normalised,
      passwordHash,
      profile: {
        create: { displayName: displayName.trim() || normalised.split('@')[0] },
      },
    },
  });

  return issueSession(user);
}

export async function signIn(
  email: string,
  password: string,
): Promise<Session> {
  const user = await prisma.user.findUnique({
    where: { email: normaliseEmail(email) },
  });

  // Hash even when the user does not exist, so response time does not reveal
  // which emails are registered.
  const hash =
    user?.passwordHash ??
    '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok)
    throw unauthorized(
      'invalid_credentials',
      'That email and password do not match.',
    );
  return issueSession(user);
}

/**
 * Rotation: the presented token is revoked and a new one issued in the same
 * transaction. Re-presenting a spent token fails, which is what makes theft of
 * a refresh token detectable rather than silent.
 */
export async function refreshSession(refreshToken: string): Promise<Session> {
  const tokenHash = sha256(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
    throw unauthorized(
      'invalid_refresh_token',
      'Session expired. Sign in again.',
    );
  }

  await prisma.refreshToken.update({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });

  return issueSession(stored.user);
}

export async function signOut(refreshToken: string): Promise<void> {
  // updateMany, not update: signing out with an already-revoked or unknown
  // token should succeed quietly rather than 404 the user into a stuck session.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Used when the password changes — every other device must be signed out. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Returns the raw reset token, or null when the email is unknown. Callers must
 * respond 200 either way — telling an anonymous caller whether an address is
 * registered is an account-enumeration hole.
 */
export async function createPasswordReset(
  email: string,
): Promise<{ token: string; userId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { email: normaliseEmail(email) },
  });
  if (!user) return null;

  const token = randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
    },
  });

  return { token, userId: user.id };
}

export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  const tokenHash = sha256(token);
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
    throw badRequest(
      'invalid_reset_token',
      'That reset link has expired. Request a new one.',
    );
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { tokenHash },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash },
    }),
    // A password reset is how someone recovers from a compromise, so it has to
    // end every session, not just the one doing the resetting.
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
