/**
 * Run logs for the scrapers.
 *
 * The jobs record every outcome in sync_log and return it as JSON when they
 * finish, which answers "what happened" afterwards but tells you nothing while a
 * run is in flight — and a sync run hits four scrapers and six follow-up passes.
 * This prints the same outcomes as they happen, aligned so a failing provider is
 * visible at a glance:
 *
 *   [sync-ipos]   NSE            ok     42 rows   1.21s
 *   [sync-ipos]   BSE            FAIL    0 rows   0.83s  BSE responded 503
 *
 * Never log a row itself. DueRow carries a PAN (checkAllotments.ts), and these
 * lines end up in a platform's log drain — counts and company names only.
 */
import { env } from '../env.js';

export type JobLog = {
  start(detail?: string): void;
  /** One provider or pass, as it lands in sync_log. */
  step(label: string, ok: boolean, rows: number, ms?: number, message?: string): void;
  /** A free-form indented line, for anything that is not a sync_log outcome. */
  note(text: string): void;
  done(summary: string, ok: boolean): void;
  /** Milliseconds since this logger was created. */
  elapsed(): number;
};

/** Widest label in use is KFINTECH_ALLOTMENT_CHECK's shorter siblings; 14 fits them all. */
const LABEL_WIDTH = 14;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/**
 * Silent under NODE_ENV=test, the same gate app.ts puts on morgan. The job unit
 * suites drive these functions directly and would otherwise bury their own
 * failures in run output.
 */
const silent: JobLog = {
  start() {},
  step() {},
  note() {},
  done() {},
  elapsed: () => 0,
};

export function jobLog(job: string): JobLog {
  if (env.NODE_ENV === 'test') return silent;

  const startedAt = Date.now();
  const prefix = `[${job}]`;

  return {
    start(detail) {
      console.info(`${prefix} start${detail ? ` — ${detail}` : ''}`);
    },

    step(label, ok, rows, ms, message) {
      const line = [
        `${prefix}  `,
        label.padEnd(LABEL_WIDTH),
        ok ? 'ok  ' : 'FAIL',
        `${String(rows).padStart(5)} rows`,
        ms === undefined ? '        ' : seconds(ms).padStart(8),
        message ?? '',
      ]
        .join(' ')
        .trimEnd();

      if (ok) console.info(line);
      else console.warn(line);
    },

    note(text) {
      console.info(`${prefix}   ${text}`);
    },

    done(summary, ok) {
      const line = `${prefix} done in ${seconds(Date.now() - startedAt)} — ${summary}`;
      if (ok) console.info(line);
      else console.warn(line);
    },

    elapsed: () => Date.now() - startedAt,
  };
}
