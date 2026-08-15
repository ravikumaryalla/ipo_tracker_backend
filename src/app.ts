import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { httpLog } from './middleware/httpLog.js';
import { accountsRouter } from './routes/accounts.js';
import { allotmentsRouter } from './routes/allotments.js';
import { applicationsRouter } from './routes/applications.js';
import { authRouter } from './routes/auth.js';
import { iposRouter } from './routes/ipos.js';
import { jobsRouter } from './routes/jobs.js';
import { miscRouter } from './routes/misc.js';

/**
 * Built separately from the listener so tests can mount it with supertest.
 */
export function createApp() {
  const app = express();

  // Behind a platform proxy (Railway/Render/Fly), so the rate limiters and logs
  // see the real client address rather than the proxy's.
  app.set('trust proxy', 1);

  app.use(helmet());
  // A native app sends no Origin header and is unaffected by CORS; this only
  // matters for the Expo web build, so the allowed list is explicit and empty
  // by default.
  app.use(cors({ origin: env.corsOrigins.length > 0 ? env.corsOrigins : false }));
  app.use(express.json({ limit: '2mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan('tiny'));
  // After the parser, because it reads req.body — a body too malformed to parse
  // never reaches this and shows up as morgan's 400 instead. Morgan stays the
  // always-on access log; this is the opt-in detail log behind DEBUG_HTTP.
  app.use(httpLog);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/auth', authRouter);
  app.use('/accounts', accountsRouter);
  app.use('/applications', applicationsRouter);
  app.use('/ipos', iposRouter);
  app.use('/allotments', allotmentsRouter);
  app.use('/jobs', jobsRouter);
  // brokers, sync-status, profile, push-tokens — mounted at the root because
  // each is a single resource rather than a collection worth its own prefix.
  app.use('/', miscRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
