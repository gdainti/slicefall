import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Duplex } from 'node:stream';
import type { ScoreDb } from './db.ts';
import { eventMessage, validateEvent } from './events.ts';
import { type MatchOptions, Matches } from './match.ts';
import { type Notify, silent } from './notifier.ts';
import { MODES, type Mode, PLAYER_ID, SESSION_SLACK_MS, validate, validateGame, weekStart } from './scores.ts';
import { statsPage } from './stats.ts';
import { acceptUpgrade, refuseUpgrade } from './ws.ts';

export interface AppOptions {
  db: ScoreDb;
  /** The built game (dist/). Null serves the API only, e.g. next to the Vite dev server. */
  staticDir: string | null;
  /** Header holding the client IP when behind a reverse proxy, e.g. "x-forwarded-for". */
  addressHeader?: string;
  /** Score submissions allowed per IP per window. */
  rateLimit?: { max: number; windowMs: number };
  /** Game-log records allowed per IP per window. */
  gameRateLimit?: { max: number; windowMs: number };
  /** Game sessions started per IP per window. */
  sessionRateLimit?: { max: number; windowMs: number };
  /** Online rooms created or joined per IP per window. */
  matchRateLimit?: { max: number; windowMs: number };
  /** Reports for the events chat (POST /api/events) allowed per IP per window. */
  eventRateLimit?: { max: number; windowMs: number };
  /**
   * Password for the /stats page (HTTP Basic auth, any user name). Without one the page is off
   * and answers 404, like any unknown path.
   */
  statsPassword?: string;
  /** Wrong /stats passwords allowed per IP per window. */
  statsRateLimit?: { max: number; windowMs: number };
  /** Posts to the events chat (notifier.ts). Default: nothing is posted. */
  notify?: Notify;
  match?: MatchOptions;
  now?: () => Date;
}

/** The HTTP server, plus a way to end the online games' WebSockets, which server.close() waits for. */
export type AppServer = Server & { closeMatches(): void; readonly matches: Matches };

const BOARD_SIZE = 10;
const MAX_BODY = 2048;
/** A field's state message is a few hundred bytes; one with every piece's shape is a few kB. */
const MAX_MESSAGE = 32 * 1024;
const PING_MS = 25_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Only itch.io may frame the game: its page (*.itch.io) holds a frame from *.itch.zone, which holds
// itch/index.html's iframe of this site. frame-ancestors is checked against every one of them.
const FRAME_ANCESTORS = 'https://itch.io https://*.itch.io https://*.itch.zone';

// Google Tag Manager (public/analytics.js) and the Google Analytics it sends to, as Google lists them
// for a Content-Security-Policy.
const GOOGLE_TAG = 'https://*.googletagmanager.com';
const GOOGLE_ANALYTICS = 'https://*.google-analytics.com https://*.analytics.google.com';

/**
 * The online games' WebSocket goes back to the same host. CSP 3 counts that as 'self', but older
 * Safari did not, so the host is named too. A Host header that isn't a plain host name is left out.
 */
function securityHeaders(host: string | undefined): Record<string, string> {
  const socket = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? ` wss://${host} ws://${host}` : '';
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self' ${GOOGLE_TAG}; connect-src 'self'${socket} ${GOOGLE_TAG} ${GOOGLE_ANALYTICS}; img-src 'self' data: ${GOOGLE_TAG} ${GOOGLE_ANALYTICS}; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`,
  };
}

interface StaticFile {
  body: Buffer;
  gzip: Buffer | null;
  type: string;
  cache: string;
}

/** Loads the whole build into memory: it is a few hundred kB and never changes in a running container. */
function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const url = '/' + relative(dir, path).split('\\').join('/');
      const type = TYPES[extname(path)] ?? 'application/octet-stream';
      const body = readFileSync(path);
      const compressible = /^(text\/|application\/(json|manifest)|image\/svg)/.test(type) && body.length > 1024;
      files.set(url, {
        body,
        gzip: compressible ? gzipSync(body, { level: 9 }) : null,
        type,
        // Vite puts a content hash in every file name under assets/, so those never change.
        cache: url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
  };
  walk(dir);
  return files;
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...securityHeaders(res.req.headers.host), 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function json(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Who a request counts against for rate limiting. An IPv6 user usually gets a whole /64 and could
 * take a fresh address for every request, so IPv6 addresses count per /64. IPv4 counts as is.
 */
export function rateKey(ip: string): string {
  const addr = ip.replace(/%.*$/, '').toLowerCase();
  if (!addr.includes(':')) return addr;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  // Expand "::" so the first four groups can be read off. A trailing dotted IPv4 part is two groups.
  const groups = (part: string) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = addr.split('::');
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

/** Sliding-window counter per IP. Old IPs are dropped as the map is used. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (ip: string, now: number): boolean => {
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    return true;
  };
}

/**
 * Browsers always send Origin with a WebSocket; it must be this site, so other pages can't use the
 * rooms. Clients that aren't browsers send none and can claim anything anyway.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createApp(opts: AppOptions): AppServer {
  const { db, addressHeader } = opts;
  const now = opts.now ?? (() => new Date());
  const files = opts.staticDir ? loadStatic(opts.staticDir) : new Map<string, StaticFile>();
  const limit = rateLimiter(opts.rateLimit?.max ?? 30, opts.rateLimit?.windowMs ?? 10 * 60_000);
  // Every finished game is logged, and a game can end within seconds, so this one is looser.
  const gameLimit = rateLimiter(opts.gameRateLimit?.max ?? 60, opts.gameRateLimit?.windowMs ?? 10 * 60_000);
  // Every game, logged or not, starts one, so a few more than games.
  const sessionLimit = rateLimiter(opts.sessionRateLimit?.max ?? 90, opts.sessionRateLimit?.windowMs ?? 10 * 60_000);
  // Each create or join counts; a rematch stays in its room and doesn't.
  const matchLimit = rateLimiter(opts.matchRateLimit?.max ?? 30, opts.matchRateLimit?.windowMs ?? 10 * 60_000);
  // A game sends two reports (start and finish), so this allows about 30 games in 10 minutes. Past
  // that the reports are refused: they're only news for the chat, and the chat shouldn't flood.
  const eventLimit = rateLimiter(opts.eventRateLimit?.max ?? 60, opts.eventRateLimit?.windowMs ?? 10 * 60_000);
  // Only wrong passwords count, so the owner can reload the page freely; past the limit an address
  // is refused even with the right one, until the window has passed.
  const statsMax = opts.statsRateLimit?.max ?? 10;
  const statsWindow = opts.statsRateLimit?.windowMs ?? 10 * 60_000;
  const statsFails = new Map<string, number[]>();
  const recentFails = (ip: string, t: number) => (statsFails.get(ip) ?? []).filter((f) => t - f < statsWindow);
  const statsKey = opts.statsPassword ? createHash('sha256').update(opts.statsPassword).digest() : null;
  const notify = opts.notify ?? silent;
  const matches = new Matches({
    ...opts.match,
    onRound: (r) => {
      db.addMatch(r, now());
      console.log(`[match] round ${r.round} ${r.ended} ${r.hostScore ?? '-'}:${r.guestScore ?? '-'}`);
    },
    now: () => now().getTime(),
  });

  const clientIp = (req: IncomingMessage): string => {
    const forwarded = addressHeader ? req.headers[addressHeader.toLowerCase()] : undefined;
    const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
    // The proxy appends the address it saw, so the last entry is the one a client can't fake.
    const last = value?.split(',').at(-1)?.trim();
    return last || req.socket.remoteAddress || 'unknown';
  };

  const boards = (mode: Mode) => {
    const since = weekStart(now());
    return {
      mode,
      weekStart: since.toISOString(),
      week: db.board(mode, since, BOARD_SIZE),
      allTime: db.board(mode, null, BOARD_SIZE),
    };
  };

  /** Reads a JSON POST body. Sends the error itself and returns undefined when there is none to use. */
  async function postedJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    if (req.method !== 'POST') return void json(res, 405, { error: 'method not allowed' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return void json(res, 415, { error: 'send application/json' });
    }
    const raw = await readBody(req);
    if (raw === null) return void json(res, 413, { error: 'body too large' });
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return void json(res, 400, { error: 'invalid JSON' });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';

    if (path === '/healthz') {
      if (!read) return json(res, 405, { error: 'method not allowed' });
      return db.ping() ? send(res, 200, 'ok', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }) : json(res, 503, { error: 'database unavailable' });
    }

    if (path === '/api/leaderboard') {
      if (!read) return json(res, 405, { error: 'method not allowed' });
      const mode = url.searchParams.get('mode') as Mode;
      if (!MODES.includes(mode)) return json(res, 400, { error: 'mode must be "cut"' });
      return json(res, 200, boards(mode));
    }

    // A game starts a session; only a game with one is logged, and only a logged game is scored.
    if (path === '/api/games/start') {
      const body = await postedJson(req, res);
      if (body === undefined) return;
      const player = (body as { player?: unknown } | null)?.player;
      if (player !== undefined && (typeof player !== 'string' || !PLAYER_ID.test(player))) {
        return json(res, 400, { error: 'player must be 32 lowercase hex digits' });
      }
      const at = now();
      if (!sessionLimit(rateKey(clientIp(req)), at.getTime())) return json(res, 429, { error: 'too many games, try again later' });
      return json(res, 201, { session: db.startSession((player as string | undefined) ?? null, at) });
    }

    if (path === '/api/games') {
      const body = await postedJson(req, res);
      if (body === undefined) return;
      const checked = validateGame(body);
      if (!checked.ok) return json(res, 400, { error: checked.error });
      const at = now();
      if (!gameLimit(rateKey(clientIp(req)), at.getTime())) return json(res, 429, { error: 'too many games, try again later' });
      const g = checked.value;
      // Taken even when the game is then refused: a session is good for one try.
      const session = db.takeSession(g.session, at);
      if (!session) return json(res, 400, { error: 'unknown, used or expired session' });
      if (session.player !== (g.player ?? null)) return json(res, 400, { error: 'session belongs to another player' });
      if (g.durationMs > at.getTime() - session.startedAt + SESSION_SLACK_MS) {
        console.warn(`[game] refused ${g.durationMs} ms of play in ${at.getTime() - session.startedAt} ms, score ${g.score}`);
        return json(res, 400, { error: 'game longer than its session' });
      }
      return json(res, 201, { id: db.addGame(g, at) });
    }

    if (path === '/api/events') {
      const body = await postedJson(req, res);
      if (body === undefined) return;
      const checked = validateEvent(body);
      if (!checked.ok) return json(res, 400, { error: checked.error });
      if (!eventLimit(rateKey(clientIp(req)), now().getTime())) return json(res, 429, { error: 'too many events, try again later' });
      // Not awaited: the game doesn't wait on Telegram, and notify never throws.
      void notify(eventMessage(checked.value));
      return json(res, 202, { ok: true });
    }

    if (path === '/api/scores') {
      const body = await postedJson(req, res);
      if (body === undefined) return;
      const checked = validate(body);
      if (!checked.ok) return json(res, 400, { error: checked.error });
      const at = now();
      if (!limit(rateKey(clientIp(req)), at.getTime())) return json(res, 429, { error: 'too many scores, try again later' });

      const s = db.add(checked.value, at);
      if (!s) return json(res, 400, { error: 'no logged game with that session to score' });
      console.log(`[score] ${s.mode} ${s.name} ${s.score}`);
      return json(res, 201, {
        id: s.id,
        name: s.name,
        weekRank: db.rank(s.mode, s.name, weekStart(at)),
        allTimeRank: db.rank(s.mode, s.name, null),
        ...boards(s.mode),
      });
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    if (path === '/stats' && statsKey) {
      if (!read) return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
      const ip = rateKey(clientIp(req));
      const t = now().getTime();
      if (recentFails(ip, t).length >= statsMax) return send(res, 429, 'Too many tries, try again later', { 'Content-Type': 'text/plain' });
      const auth = /^Basic (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const given = auth ? Buffer.from(auth, 'base64').toString('utf8').replace(/^[^:]*:/, '') : null;
      // Hashed first so both sides have the same length for the constant-time compare.
      const ok = given !== null && timingSafeEqual(createHash('sha256').update(given).digest(), statsKey);
      if (!ok) {
        if (given !== null) {
          statsFails.set(ip, [...recentFails(ip, t), t]);
          if (statsFails.size > 10_000) for (const [k] of statsFails) if (!recentFails(k, t).length) statsFails.delete(k);
        }
        return send(res, 401, 'Password needed', {
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Basic realm="Slicefall stats", charset="UTF-8"',
          'Cache-Control': 'no-store',
        });
      }
      return send(res, 200, statsPage(db, now()), {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, private',
        'X-Robots-Tag': 'noindex, nofollow',
      });
    }

    if (!read) return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const gzip = file.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    return send(res, 200, gzip ? file.gzip! : file.body, {
      'Content-Type': file.type,
      'Cache-Control': file.cache,
      Vary: 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
      else res.destroy();
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/match') return refuseUpgrade(socket, 404, 'Not Found');
    if (!sameOrigin(req)) {
      console.warn(`[match] refused origin ${req.headers.origin} on host ${req.headers.host}`);
      return refuseUpgrade(socket, 403, 'Forbidden');
    }
    const conn = acceptUpgrade(req, socket, head, { maxMessage: MAX_MESSAGE, pingMs: PING_MS });
    if (!conn) return;
    const ip = rateKey(clientIp(req));
    matches.add(conn, () => matchLimit(ip, now().getTime()));
  });

  return Object.assign(server, { closeMatches: () => matches.closeAll(), matches });
}
