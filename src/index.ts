import { createApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';

const server = createApp().listen(env.PORT, () => {
  console.info(`ipo-tracker API listening on :${env.PORT} (${env.NODE_ENV})`);
});

/**
 * Platforms send SIGTERM and then SIGKILL a few seconds later. Draining
 * in-flight requests first matters here because a sync run can be mid-upsert.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.info(`${signal} received, shutting down`);
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
}
