import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { type AppServer, createApp } from './app.ts';
import { ScoreDb } from './db.ts';
import { CODE_CHARS, normalizeCode } from './match.ts';

type Msg = { t: string; [k: string]: unknown };

/** A WebSocket client (Node's own) that queues what it receives, so tests can await each message. */
class Client {
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  private queue: Msg[] = [];
  private waiting: ((m: Msg) => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('could not connect')));
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener('close', (e) => resolve(e.code)));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      const w = this.waiting.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }

  send(m: unknown) {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  next(): Promise<Msg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no message')), 2000);
      this.waiting.push((msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }

  close() {
    this.ws.close();
  }
}

describe('online rooms', () => {
  const db = new ScoreDb(':memory:');
  let server: AppServer;
  let url = '';
  let port = 0;

  before(async () => {
    server = createApp({
      db,
      staticDir: null,
      addressHeader: 'x-forwarded-for',
      matchRateLimit: { max: 1000, windowMs: 60_000 },
      match: { maxRooms: 5, helloMs: 300 },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/api/match`;
  });

  after(() => {
    server.closeMatches();
    server.close();
    db.close();
  });

  /** Opens a room and joins it; returns both players once both got their start. */
  async function pair(ids: [unknown, unknown] = [undefined, undefined], attacks?: boolean, pieces?: unknown, hold?: unknown) {
    const a = new Client(url);
    await a.opened;
    a.send({ t: 'create', player: ids[0], attacks, pieces, hold });
    const room = await a.next();
    assert.equal(room.t, 'room');
    const b = new Client(url);
    await b.opened;
    b.send({ t: 'join', code: String(room.code).toLowerCase(), player: ids[1] });
    const [sa, sb] = [await a.next(), await b.next()];
    return { a, b, code: room.code as string, sa, sb };
  }

  test('codes are four unambiguous characters', () => {
    assert.equal(normalizeCode(' k7-qx '), 'K7QX');
    for (const bad of ['K7Q', 'K7QXX', 'K0QX', 'KIQX', 'KLQX', 42, null]) assert.equal(normalizeCode(bad), null, String(bad));
    assert.ok(!/[ILO01]/.test(CODE_CHARS));
  });

  test('create, join, and both start with the same seed', async () => {
    const { a, b, code, sa, sb } = await pair();
    assert.match(code, /^[A-Z2-9]{4}$/);
    assert.equal(sa.t, 'start');
    assert.equal(sb.t, 'start');
    assert.equal(sa.seed, sb.seed);
    assert.equal(sa.round, 1);
    a.close();
    b.close();
  });

  test('state goes to the other player as is', async () => {
    const { a, b } = await pair();
    a.send({ t: 'state', s: 120, p: [[1, 2, 3, 0.5]] });
    assert.deepEqual(await b.next(), { t: 'state', s: 120, p: [[1, 2, 3, 0.5]] });
    b.send({ t: 'state', s: 7 });
    assert.deepEqual(await a.next(), { t: 'state', s: 7 });
    a.close();
    b.close();
  });

  test('the first to top out loses, whatever the scores, then a rematch starts round 2', async () => {
    const { a, b, sa } = await pair();
    a.send({ t: 'over', score: 450 });
    a.send({ t: 'rematch' }); // too early: ignored
    assert.deepEqual(await b.next(), { t: 'won' });
    b.send({ t: 'over', score: 300 });
    assert.deepEqual(await a.next(), { t: 'result', you: 450, them: 300, win: false });
    assert.deepEqual(await b.next(), { t: 'result', you: 300, them: 450, win: true });

    b.send({ t: 'rematch' });
    assert.deepEqual(await a.next(), { t: 'rematch' });
    a.send({ t: 'rematch' });
    const [ra, rb] = [await a.next(), await b.next()];
    assert.equal(ra.t, 'start');
    assert.equal(ra.round, 2);
    assert.equal(ra.seed, rb.seed);
    assert.notEqual(ra.seed, sa.seed);
    a.close();
    b.close();
  });

  test('a bad score is ignored', async () => {
    const { a, b } = await pair();
    a.send({ t: 'over', score: -5 });
    a.send({ t: 'over', score: 1.5 });
    a.send({ t: 'over', score: 10 });
    b.send({ t: 'over', score: 20 });
    assert.deepEqual(await a.next(), { t: 'result', you: 10, them: 20, win: false });
    a.close();
    b.close();
  });

  test('when one player leaves, the other is told and the room is gone', async () => {
    const { a, b, code } = await pair();
    const before = server.matches.size;
    a.close();
    assert.deepEqual(await b.next(), { t: 'left' });
    assert.equal(await b.closed, 1000);
    assert.equal(server.matches.size, before - 1);
    const c = new Client(url);
    await c.opened;
    c.send({ t: 'join', code });
    assert.deepEqual(await c.next(), { t: 'error', error: 'not-found' });
  });

  test('a full room and a wrong code are refused', async () => {
    const { a, b, code } = await pair();
    const c = new Client(url);
    await c.opened;
    c.send({ t: 'join', code });
    assert.deepEqual(await c.next(), { t: 'error', error: 'full' });
    const d = new Client(url);
    await d.opened;
    d.send({ t: 'join', code: 'nope' });
    assert.deepEqual(await d.next(), { t: 'error', error: 'not-found' });
    a.close();
    b.close();
  });

  test('a connection that never says create or join is closed', async () => {
    const a = new Client(url);
    await a.opened;
    assert.equal(await a.closed, 1008);
  });

  test('anything but create or join first, or bad JSON, closes the connection', async () => {
    const a = new Client(url);
    await a.opened;
    a.send({ t: 'state' });
    assert.equal(await a.closed, 1002);
    const b = new Client(url);
    await b.opened;
    b.send('{nope');
    assert.equal(await b.closed, 1002);
  });

  test('too many rooms at once are refused', async () => {
    const open: Client[] = [];
    let refused: Msg | null = null;
    for (let i = 0; i < 6 && !refused; i++) {
      const c = new Client(url);
      await c.opened;
      c.send({ t: 'create' });
      const m = await c.next();
      if (m.t === 'error') refused = m;
      open.push(c);
    }
    assert.deepEqual(refused, { t: 'error', error: 'busy' });
    for (const c of open) c.close();
  });

  test('a message over the size limit closes the connection', async () => {
    const { a, b } = await pair();
    a.send({ t: 'state', junk: 'x'.repeat(40_000) });
    assert.equal(await a.closed, 1009);
    assert.deepEqual(await b.next(), { t: 'left' });
  });

  const HOST = 'a'.repeat(32);
  const GUEST = 'b'.repeat(32);
  const latest = () => ({ ...(db.recentMatches(1)[0] as Record<string, unknown>) });

  test('a finished round goes in the match log, then a rematch and a round left half way', async () => {
    const { a, b } = await pair([HOST, GUEST]);
    a.send({ t: 'over', score: 300, tSpins: 3, tSpinPoints: 111 });
    b.send({ t: 'over', score: 450 }); // an older client: no T-spins
    await a.next();
    const first = latest();
    assert.equal(first.host_t_spins, 3);
    assert.equal(first.guest_t_spins, null);
    assert.deepEqual(
      { ...db.sql.prepare('SELECT host_t_spin_points, guest_t_spin_points FROM match WHERE id = ?').get(first.id as number) },
      { host_t_spin_points: 111, guest_t_spin_points: null },
    );
    assert.equal(first.round, 1);
    assert.equal(first.host, HOST);
    assert.equal(first.guest, GUEST);
    assert.equal(first.host_score, 300);
    assert.equal(first.guest_score, 450);
    assert.equal(first.winner, 'guest');
    assert.equal(first.ended, 'finished');
    assert.match(String(first.room), /^[0-9a-f]{12}$/);

    a.send({ t: 'rematch' });
    b.send({ t: 'rematch' });
    assert.equal((await a.next()).t, 'start');
    assert.deepEqual(
      [(await b.next()).t, (await b.next()).t, (await b.next()).t, (await b.next()).t],
      ['won', 'result', 'rematch', 'start'],
    );
    b.send({ t: 'over', score: 80, tSpins: 1, tSpinPoints: 100 }); // more T-spin points than score
    a.close();
    assert.deepEqual(await b.next(), { t: 'left' });
    const second = latest();
    assert.equal(second.room, first.room);
    assert.equal(second.round, 2);
    assert.equal(second.ended, 'host-left');
    assert.equal(second.host_score, null);
    assert.equal(second.guest_score, 80);
    assert.equal(second.host_t_spins, null);
    assert.equal(second.guest_t_spins, null); // 100 T-spin points don't fit in 80: not logged
    assert.equal(second.winner, null);
  });

  test('leaving after a finished round adds nothing; a room nobody joined logs nothing', async () => {
    const { a, b } = await pair();
    a.send({ t: 'over', score: 5 });
    b.send({ t: 'over', score: 5 });
    await a.next();
    const finished = latest();
    assert.equal(finished.winner, 'guest'); // the same score, but the host topped out first
    assert.equal(finished.host, null);
    b.close();
    assert.deepEqual(await a.next(), { t: 'left' });
    assert.equal(latest().id, finished.id);

    const c = new Client(url);
    await c.opened;
    c.send({ t: 'create' });
    await c.next();
    c.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(latest().id, finished.id);
  });

  test('a player id that is not 32 hex digits is logged as none', async () => {
    const { a, b } = await pair(['NOT-AN-ID', 42]);
    a.close();
    await b.next();
    const row = latest();
    assert.equal(row.host, null);
    assert.equal(row.guest, null);
    assert.equal(row.ended, 'host-left');
  });

  test('start says whether attacks are on: the host decides, on unless they say no', async () => {
    const on = await pair();
    assert.equal(on.sa.attacks, true);
    assert.equal(on.sb.attacks, true);
    on.a.close();
    on.b.close();
    const off = await pair(undefined, false);
    assert.equal(off.sa.attacks, false);
    assert.equal(off.sb.attacks, false);
    off.a.close();
    off.b.close();
  });

  test('start passes on the host piece order: bag when asked for, random otherwise', async () => {
    const bag = await pair(undefined, undefined, 'bag');
    assert.equal(bag.sa.pieces, 'bag');
    assert.equal(bag.sb.pieces, 'bag');
    bag.a.close();
    bag.b.close();
    for (const asked of [undefined, 'random', 'nonsense', 7]) {
      const r = await pair(undefined, undefined, asked);
      assert.equal(r.sa.pieces, 'random', String(asked));
      assert.equal(r.sb.pieces, 'random', String(asked));
      r.a.close();
      r.b.close();
    }
  });

  test('start passes on the host hold setting: on only when asked for', async () => {
    const on = await pair(undefined, undefined, undefined, true);
    assert.equal(on.sa.hold, true);
    assert.equal(on.sb.hold, true);
    on.a.close();
    on.b.close();
    for (const asked of [undefined, false, 'yes', 1]) {
      const r = await pair(undefined, undefined, undefined, asked);
      assert.equal(r.sa.hold, false, String(asked));
      assert.equal(r.sb.hold, false, String(asked));
      r.a.close();
      r.b.close();
    }
  });

  test('attacks go to the other player, at most one a second and 1 to 5 blocks', async () => {
    const { a, b } = await pair();
    a.send({ t: 'attack', n: 2 });
    a.send({ t: 'attack', n: 1 }); // too soon after the last one
    b.send({ t: 'attack', n: 0 });
    b.send({ t: 'attack', n: 6 });
    b.send({ t: 'attack', n: 1.5 });
    b.send({ t: 'attack', n: '3' });
    b.send({ t: 'attack', n: 3 });
    a.send({ t: 'state', s: 1 });
    b.send({ t: 'state', s: 2 });
    // Order is kept, so what arrives before each state is everything that got through
    assert.deepEqual(await b.next(), { t: 'attack', n: 2 });
    assert.deepEqual(await b.next(), { t: 'state', s: 1 });
    assert.deepEqual(await a.next(), { t: 'attack', n: 3 });
    assert.deepEqual(await a.next(), { t: 'state', s: 2 });
    a.close();
    b.close();
  });

  test('no attacks once either player has topped out, or with attacks off', async () => {
    const one = await pair();
    one.a.send({ t: 'over', score: 10 });
    one.b.send({ t: 'attack', n: 2 }); // a is out: nothing to send it to
    one.a.send({ t: 'attack', n: 2 }); // a is out: can't attack
    one.b.send({ t: 'state', s: 1 });
    one.a.send({ t: 'state', s: 2 });
    assert.deepEqual(await one.a.next(), { t: 'state', s: 1 });
    assert.deepEqual(await one.b.next(), { t: 'won' });
    assert.deepEqual(await one.b.next(), { t: 'state', s: 2 });
    one.a.close();
    one.b.close();

    const off = await pair(undefined, false);
    off.a.send({ t: 'attack', n: 2 });
    off.a.send({ t: 'state', s: 3 });
    assert.deepEqual(await off.b.next(), { t: 'state', s: 3 });
    off.a.close();
    off.b.close();
  });

  test('another site may not open a room', async () => {
    const status = await rawUpgrade(port, '/api/match', 'https://evil.example');
    assert.match(status, / 403 /);
  });

  test('only /api/match upgrades', async () => {
    const status = await rawUpgrade(port, '/api/other', null);
    assert.match(status, / 404 /);
  });

  test('the page allows a socket back to its own host', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.match(r.headers.get('content-security-policy') ?? '', new RegExp(`connect-src 'self' wss://127\\.0\\.0\\.1:${port} ws://127\\.0\\.0\\.1:${port}[ ;]`));
  });
});

describe('match log', () => {
  test('rounds cut short by a server restart are logged as such', async () => {
    const db = new ScoreDb(':memory:');
    const server = createApp({ db, staticDir: null });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/match`;
    const a = new Client(url);
    await a.opened;
    a.send({ t: 'create' });
    const room = await a.next();
    const b = new Client(url);
    await b.opened;
    b.send({ t: 'join', code: room.code });
    await a.next();
    server.closeMatches();
    assert.equal(await a.closed, 1001);
    assert.equal((db.recentMatches(1)[0] as { ended: string }).ended, 'restart');
    server.close();
    db.close();
  });

  test('totals: rounds, how they ended, rooms, rematches and devices', () => {
    const db = new ScoreDb(':memory:');
    const at = new Date('2026-11-18T12:00:00Z');
    const base = {
      host: 'a'.repeat(32),
      guest: 'b'.repeat(32),
      hostScore: 10,
      guestScore: 20,
      hostTSpins: null,
      hostTSpinPoints: null,
      guestTSpins: null,
      guestTSpinPoints: null,
      winner: 'guest' as const,
      durationMs: 60_000,
    };
    db.addMatch({ ...base, room: 'r1', round: 1, ended: 'finished' }, at);
    db.addMatch({ ...base, room: 'r1', round: 2, ended: 'finished' }, at);
    db.addMatch({ ...base, room: 'r2', round: 1, guest: 'c'.repeat(32), guestScore: null, ended: 'guest-left' }, at);
    db.addMatch({ ...base, room: 'r3', round: 1, host: null, ended: 'restart', hostScore: null, guestScore: null }, new Date('2026-11-01T00:00:00Z'));
    assert.deepEqual({ ...db.matchTotals(null) }, { rounds: 4, finished: 2, left: 2, rooms: 3, rematches: 1, devices: 3, playMs: 240_000 });
    assert.deepEqual({ ...db.matchTotals(new Date('2026-11-16T00:00:00Z')) }, { rounds: 3, finished: 2, left: 1, rooms: 2, rematches: 1, devices: 3, playMs: 180_000 });
    assert.deepEqual(
      db.matchesByPlayer('c').map((m) => ({ ...(m as object) })).map((m) => (m as { winner: string | null }).winner),
      [null],
    );
    assert.equal(db.matchesByPlayer('a').length, 3);
    db.close();
  });
});

describe('online rooms rate limit', () => {
  const db = new ScoreDb(':memory:');
  let server: AppServer;
  let url = '';

  before(async () => {
    server = createApp({ db, staticDir: null, matchRateLimit: { max: 2, windowMs: 60_000 } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/match`;
  });

  after(() => {
    server.closeMatches();
    server.close();
    db.close();
  });

  test('guessing codes runs into the per-address limit', async () => {
    const results: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const c = new Client(url);
      await c.opened;
      c.send({ t: 'join', code: 'AAAA' });
      results.push((await c.next()).error);
    }
    assert.deepEqual(results, ['not-found', 'not-found', 'limit']);
  });
});

/** Sends a WebSocket upgrade by hand and returns the status line, for the cases a client can't make. */
function rawUpgrade(port: number, path: string, origin: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          (origin ? `Origin: ${origin}\r\n` : '') +
          '\r\n',
      );
    });
    let data = '';
    s.on('data', (d) => (data += d.toString()));
    s.on('close', () => resolve(data.split('\r\n')[0]));
    s.on('error', reject);
  });
}
