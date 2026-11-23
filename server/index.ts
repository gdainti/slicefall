// Entry point: serves the built game, the leaderboard API and the online Versus rooms from one process.
//
//   DATABASE_URL    SQLite file (default data/slicefall.db; /data/slicefall.db in Docker)
//   PORT            default 5034
//   STATIC_DIR      the built game, default dist (set it empty to serve the API only)
//   ADDRESS_HEADER  header with the client IP behind a reverse proxy, e.g. x-forwarded-for
//   STATS_PASSWORD  password for the /stats page (HTTP Basic auth, any user name); empty = page off
//   TG_PIGEON_URL   tg-pigeon base URL for events chat reports, e.g. http://tg-pigeon:5040 (empty = off)
//   TG_PIGEON_TOKEN tg-pigeon's API_TOKEN (empty = off). Only production (NODE_ENV=production) posts.

import { existsSync, readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { ScoreDb } from './db.ts';
import { notifierFromEnv } from './notifier.ts';

const port = Number(process.env.PORT || 5034);
const dbFile = process.env.DATABASE_URL || 'data/slicefall.db';
const staticDir = process.env.STATIC_DIR ?? 'dist';
const serveStatic = staticDir !== '' && existsSync(staticDir);
if (staticDir !== '' && !serveStatic) console.warn(`[slicefall] ${staticDir}/ not found: serving the API only (run npm run build)`);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const { notify, why } = notifierFromEnv(process.env);
console.log(`[slicefall] events chat notifications ${why}`);
console.log(`[slicefall] /stats ${process.env.STATS_PASSWORD ? 'on (password set)' : 'off (no STATS_PASSWORD)'}`);

const db = new ScoreDb(dbFile);
const server = createApp({
  db,
  staticDir: serveStatic ? staticDir : null,
  addressHeader: process.env.ADDRESS_HEADER || undefined,
  statsPassword: process.env.STATS_PASSWORD || undefined,
  notify,
});

server.listen(port, () => {
  console.log(`[slicefall] v${version} listening on http://localhost:${port} (database ${dbFile})`);
  void notify(`🚀 slicefall v${version} started`);
});

// Docker stops containers with SIGTERM; Node as PID 1 would otherwise ignore it.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
    // Upgraded sockets (online games) aren't HTTP connections any more, and close() waits for them.
    server.closeMatches();
  });
}
