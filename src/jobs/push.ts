/**
 * Expo push delivery, fired the instant an allotment status resolves.
 */
import { prisma } from '../db.js';
import type { AllotmentOutcome } from './checkAllotments.parse.js';
import type { CheckResult } from './checkAllotments.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const OUTCOME_TEXT: Record<AllotmentOutcome, string> = {
  ALLOTTED: 'Allotted',
  PARTIAL: 'Partially allotted',
  NOT_ALLOTTED: 'Not allotted',
};

/**
 * Best-effort: a push-delivery hiccup (Expo's service down, a stale or revoked
 * token) must never fail the check itself — the row is already written by the
 * time this runs.
 */
export async function sendAllotmentPushes(results: CheckResult[]): Promise<void> {
  const resolved = results.filter(
    (r): r is CheckResult & { status: AllotmentOutcome } => r.outcome === 'resolved' && !!r.status,
  );
  if (resolved.length === 0) return;

  try {
    const userIds = [...new Set(resolved.map((r) => r.row.userId))];
    const tokenRows = await prisma.pushToken.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, token: true },
    });

    const tokensByUser = new Map<string, string[]>();
    for (const t of tokenRows) {
      tokensByUser.set(t.userId, [...(tokensByUser.get(t.userId) ?? []), t.token]);
    }

    const messages = resolved.flatMap((r) =>
      (tokensByUser.get(r.row.userId) ?? []).map((token) => ({
        to: token,
        title: 'Allotment result is out',
        body: `${r.row.companyName}: ${OUTCOME_TEXT[r.status]}`,
        sound: 'default',
        channelId: 'allotment-results',
        data: { applicationId: r.row.id },
      })),
    );
    if (messages.length === 0) return;

    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch {
    // Never let a push failure surface as a check failure.
  }
}
