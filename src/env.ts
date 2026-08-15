/**
 * Process env, validated once at boot.
 *
 * Failing here is deliberate: a server that starts with no JWT_SECRET would
 * happily sign tokens with `undefined` and accept anyone's.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JOB_SECRET: z.string().min(32, 'JOB_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PASSWORD_RESET_URL: z.string().default('ipotracker://reset-password'),
  CORS_ORIGINS: z.string().default(''),
  /** Turns on the full request/response payload log. Off unless asked for. */
  DEBUG_HTTP: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Never on under NODE_ENV=test, whatever the var says — the suites would
   * otherwise bury their own failures under every payload they exchange.
   */
  debugHttp:
    ['1', 'true', 'yes'].includes(parsed.data.DEBUG_HTTP.trim().toLowerCase()) &&
    parsed.data.NODE_ENV !== 'test',
};

/** Access tokens are short-lived; the refresh token is the real session. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const PASSWORD_RESET_TTL_MINUTES = 60;
