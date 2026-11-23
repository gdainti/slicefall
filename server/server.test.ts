import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createApp, rateKey } from './app.ts';
import { ScoreDb } from './db.ts';
import { type GameRecord, normalizeName, SESSION_MAX_AGE_MS, type Submission, validate, validateGame, weekStart } from './scores.ts';

let sessions = 0;
/** A fresh session id, as the server would make (the unit tests don't need a real one). */
const sid = () => (++sessions).toString(16).padStart(32, '0');

const claim = (over: Partial<Submission> = {}): Submission => ({ mode: 'cut', name: 'ANN', session: sid(), ...over });

const played = (over: Partial<GameRecord> = {}): GameRecord => ({
  mode: 'cut',
  score: 500,
  lines: 4,
  level: 0,
  pieces: 12,
  cuts: 2,
  bestCut: 3,
  durationMs: 60_000,
  tSpins: 0,
  tSpinPoints: 0,
  session: sid(),
  ...over,
});

/** Logs a game and puts it on the board under `name`, the way the HTTP layer does. */
function scoreGame(db: ScoreDb, name: string, over: Partial<GameRecord>, at: Date) {
  const g = played(over);
  const gameId = db.addGame(g, at);
  const score = db.add(claim({ name, session: g.session }), at);
  assert.ok(score, `${name} scored`);
  return { ...score, gameId };
}

describe('names', () => {
  test('are trimmed, squeezed and upper-cased', () => {
    assert.equal(normalizeName('  ann   lee '), 'ANN LEE');
    assert.equal(normalizeName('Jüri'), 'JÜRI');
    assert.equal(normalizeName('миша'), 'МИША');
    assert.equal(normalizeName("o'neil-2!"), "O'NEIL-2!");
    assert.equal(normalizeName('tab\there\n'), 'TAB HERE');
  });

  test('reject empty, long and odd input', () => {
    for (const bad of ['', '   ', 'ABCDEFGHIJK', '<script>', 'a😀', 'é́́', 42, null]) {
      assert.equal(normalizeName(bad), null, String(bad));
    }
  });
});

describe('validate', () => {
  test('a score is a name and a session', () => {
    const ok = validate({ mode: 'cut', name: ' ann ', session: 'ab'.repeat(16) });
    assert.deepEqual(ok, { ok: true, value: { mode: 'cut', name: 'ANN', session: 'ab'.repeat(16) } });
    // The numbers a client sends are ignored: they come from the logged game
    const extra = validate({ ...claim(), score: 99_999 });
    assert.ok(extra.ok && !('score' in extra.value));
  });

  test('rejects a bad name, mode or session', () => {
    const cases: [string, unknown][] = [
      ['mode', { ...claim(), mode: 'versus' }],
      ['name', { ...claim(), name: '<script>' }],
      ['no session', { ...claim(), session: undefined }],
      ['short session', { ...claim(), session: 'abc' }],
      ['upper-case session', { ...claim(), session: 'AB'.repeat(16) }],
      ['a game id instead', { mode: 'cut', name: 'ANN', gameId: 7 }],
      ['not an object', 'hello'],
    ];
    for (const [why, body] of cases) assert.equal(validate(body).ok, false, why);
  });
});

describe('validateGame', () => {
  test('accepts scored and scoreless games', () => {
    assert.ok(validateGame(played()).ok);
    assert.ok(validateGame(played({ score: 0, lines: 0, cuts: 0, bestCut: 0, pieces: 9, durationMs: 20_000 })).ok);
    assert.ok(validateGame(played({ score: 0, lines: 0, cuts: 0, bestCut: 0, pieces: 0, durationMs: 0 })).ok);
    assert.ok(validateGame(played({ lines: 1, cuts: 1, bestCut: 1, score: 80, pieces: 5 })).ok);
    assert.ok(validateGame(played({ lines: 25, level: 2, score: 6000, pieces: 60, cuts: 10, bestCut: 4, durationMs: 400_000 })).ok);
  });

  test('needs a session', () => {
    for (const bad of [undefined, '', 'x'.repeat(32), 42]) assert.equal(validateGame({ ...played(), session: bad }).ok, false, String(bad));
    const id = sid();
    assert.equal((validateGame(played({ session: id })) as { value: GameRecord }).value.session, id);
  });

  test('takes an optional player id of 32 lowercase hex digits', () => {
    const id = '0123456789abcdef0123456789abcdef';
    assert.deepEqual((validateGame(played({ player: id })) as { value: GameRecord }).value.player, id);
    assert.ok(!('player' in (validateGame(played()) as { value: object }).value));
    for (const bad of ['', 'ABCDEF0123456789ABCDEF0123456789', `${id}0`, id.slice(1), 'g'.repeat(32), 42, null]) {
      assert.equal(validateGame({ ...played(), player: bad }).ok, false, String(bad));
    }
  });

  test('rejects games the field cannot produce', () => {
    const cases: [string, unknown][] = [
      ['points without rows', played({ lines: 0, cuts: 0, bestCut: 0 })],
      ['rows without points', played({ score: 0 })],
      ['level not lines/10', played({ lines: 12, level: 0, pieces: 30 })],
      ['too few pieces', played({ pieces: 7 })],
      ['too fast', played({ durationMs: 1000 })],
      ['rows without cuts', played({ cuts: 0, bestCut: 0 })],
      ['more cuts than rows', played({ cuts: 5, bestCut: 1 })],
      ['cuts cannot reach the rows', played({ cuts: 1, bestCut: 3 })],
      ['best cut bigger than the rows', played({ lines: 4, cuts: 1, bestCut: 5 })],
      ['best cut bigger than the field', played({ lines: 19, level: 1, pieces: 40, score: 9000, cuts: 1, bestCut: 19 })],
      ['missing cuts', { ...played(), cuts: undefined }],
      ['mode', { ...played(), mode: 'versus' }],
      ['not an object', 42],
    ];
    for (const [why, body] of cases) assert.equal(validateGame(body).ok, false, why);
  });

  test('counts T-spin points on top of the cut points', () => {
    const spun = (over: Partial<GameRecord>) => validateGame(played(over));
    // 1 + 10 + 100 from one T, 1 from another: 112 points on top of the cuts' 500
    const ok = spun({ score: 612, tSpins: 4, tSpinPoints: 112 });
    assert.ok(ok.ok && ok.value.tSpins === 4 && ok.value.tSpinPoints === 112);
    // Only T-spins: points without rows
    assert.ok(spun({ score: 11, lines: 0, cuts: 0, bestCut: 0, tSpins: 2, tSpinPoints: 11 }).ok);
    // Older clients send neither: 0
    const old = validateGame({ ...played(), tSpins: undefined, tSpinPoints: undefined });
    assert.ok(old.ok && old.value.tSpins === 0 && old.value.tSpinPoints === 0);

    const cases: [string, unknown][] = [
      ['points without T-spins', played({ score: 501, tSpinPoints: 1 })],
      ['over 100 points a T-spin', played({ score: 701, tSpins: 2, tSpinPoints: 201 })],
      ['T-spin points over the score', played({ score: 10, lines: 0, cuts: 0, bestCut: 0, tSpins: 1, tSpinPoints: 11 })],
      ['T-spin points that leave rows without points', played({ score: 111, tSpins: 3, tSpinPoints: 111 })],
      ['too many T-spins for the time', played({ score: 600, tSpins: 61, tSpinPoints: 100, durationMs: 60_000 })],
      ['fractional T-spins', played({ tSpins: 1.5 })],
    ];
    for (const [why, body] of cases) assert.equal(validateGame(body).ok, false, why);
  });
});

describe('sessions', () => {
  const at = new Date('2026-11-18T12:00:00Z');
  const later = (ms: number) => new Date(at.getTime() + ms);

  test('are random, and can be taken once', () => {
    const db = new ScoreDb(':memory:');
    const player = 'aaaa0000000000000000000000000000';
    const a = db.startSession(player, at);
    const b = db.startSession(null, at);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    assert.deepEqual(db.takeSession(a, later(5000)), { player, startedAt: at.getTime() });
    assert.equal(db.takeSession(a, later(6000)), null);
    assert.deepEqual(db.takeSession(b, later(5000)), { player: null, startedAt: at.getTime() });
    assert.equal(db.takeSession(sid(), at), null);
    db.close();
  });

  test('expire, and old ones are dropped as new ones start', () => {
    const db = new ScoreDb(':memory:');
    const old = db.startSession(null, at);
    const kept = db.startSession(null, at);
    assert.equal(db.takeSession(old, later(SESSION_MAX_AGE_MS)), null);
    const count = () => (db.sql.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;
    assert.equal(count(), 1);
    db.startSession(null, later(SESSION_MAX_AGE_MS));
    assert.equal(count(), 1); // `kept` is gone too
    assert.equal(db.takeSession(kept, later(SESSION_MAX_AGE_MS)), null);
    db.close();
  });
});

describe('game starts', () => {
  const at = new Date('2026-11-18T12:00:00Z'); // a Wednesday
  const lastWeek = new Date('2026-11-10T12:00:00Z');
  const since = weekStart(at);
  const ann = 'aaaa0000000000000000000000000000';
  const bob = 'bbbb0000000000000000000000000000';

  test('count every started game, finished or not, and the names on the board', () => {
    const db = new ScoreDb(':memory:');
    db.startSession(ann, lastWeek);
    const used = db.startSession(ann, at);
    db.startSession(bob, at);
    db.startSession(null, at);
    db.takeSession(used, at); // a used session still counts as a start
    scoreGame(db, 'ANN', { player: ann }, lastWeek);
    scoreGame(db, 'BOB', { player: bob }, at);
    scoreGame(db, 'BOB', { player: bob }, at);
    scoreGame(db, 'INCOGNITO', {}, at); // the shared name isn't a player
    assert.deepEqual(db.boardStats('cut', since), { started: 3, names: 1 });
    assert.deepEqual(db.boardStats('cut', null), { started: 4, names: 2 });
    db.close();
  });

  test('top starters: most games started per player id, with the names they use', () => {
    const db = new ScoreDb(':memory:');
    for (let i = 0; i < 3; i++) db.startSession(bob, at);
    db.startSession(ann, at);
    db.startSession(null, at);
    scoreGame(db, 'BOB', { player: bob, score: 700 }, at);
    const top = db.topStarters(null, 10).map((r) => [r.player, r.started, r.finished, r.best, r.names]);
    assert.deepEqual(top, [
      [bob, 3, 1, 700, 'BOB'],
      [ann, 1, 0, 0, null],
    ]);
    assert.equal(db.topStarters(null, 1).length, 1);
    db.close();
  });

  test('migrating counts the logged games and open sessions as starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt2-migrate-'));
    try {
      const file = join(dir, 'scores.db');
      // A database from before game starts were kept, at user_version 9
      const old = new ScoreDb(file);
      old.addGame(played({ player: ann, durationMs: 60_000 }), at);
      old.startSession(bob, at);
      old.sql.exec('DROP TABLE game_start; PRAGMA user_version = 9;');
      old.close();
      const again = new ScoreDb(file);
      assert.deepEqual(
        again.sql.prepare('SELECT player, started_at FROM game_start ORDER BY started_at').all().map((r) => [r.player, r.started_at]),
        [
          [ann, at.getTime() - 60_000],
          [bob, at.getTime()],
        ],
      );
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stats page', () => {
  const at = new Date('2026-11-18T12:00:00Z');

  test('renders every section, with names escaped', async () => {
    const { statsPage } = await import('./stats.ts');
    const db = new ScoreDb(':memory:');
    const player = 'cccc0000000000000000000000000000';
    db.startSession(player, at);
    db.startSession(player, at);
    scoreGame(db, "<B&O'>", { player, score: 1234 }, at);
    const html = statsPage(db, at);
    for (const id of ['totals', 'charts', 'days', 'boards', 'names', 'players', 'games', 'online']) assert.match(html, new RegExp(`id="${id}"`));
    assert.ok(!html.includes("<B&O'>"));
    assert.match(html, /&lt;B&amp;O&#39;&gt;/);
    assert.match(html, /cccc0000/);
    db.close();
  });

  test('is off without a password', async () => {
    const db = new ScoreDb(':memory:');
    const app = createApp({ db, staticDir: null });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/stats`);
    assert.equal(res.status, 404);
    await new Promise((r) => app.close(r));
    db.close();
  });
});

describe('game log', () => {
  const at = new Date('2026-11-18T12:00:00Z');
  const game = (db: ScoreDb, id: number) => db.sql.prepare('SELECT name, score_id FROM game WHERE id = ?').get(id);

  test('a submitted score names its game; a skipped game stays unnamed', () => {
    const db = new ScoreDb(':memory:');
    const scored = scoreGame(db, 'ANN', {}, at);
    const skipped = db.addGame(played({ score: 300 }), at);
    assert.deepEqual({ ...game(db, scored.gameId) }, { name: 'ANN', score_id: scored.id });
    assert.deepEqual({ ...game(db, skipped) }, { name: null, score_id: null });
    db.close();
  });

  test("a score has its game's numbers, and a game is scored once", () => {
    const db = new ScoreDb(':memory:');
    const g = played({ score: 612, tSpins: 4, tSpinPoints: 112 });
    const id = db.addGame(g, at);
    const s = db.add(claim({ name: 'ANN', session: g.session }), at);
    assert.deepEqual(s, { id: s!.id, mode: 'cut', name: 'ANN', score: 612 });
    assert.deepEqual(
      db.board('cut', null, 10).map((e) => [e.name, e.score, e.lines, e.pieces]),
      [['ANN', 612, 4, 12]],
    );
    assert.equal(db.add(claim({ name: 'EVE', session: g.session }), at), null);
    assert.equal(game(db, id)!.name, 'ANN');
    assert.equal(db.board('cut', null, 10).length, 1);
    db.close();
  });

  test('no score without a logged game, or for a game that scored nothing', () => {
    const db = new ScoreDb(':memory:');
    assert.equal(db.add(claim({ name: 'BOB' }), at), null);
    const zero = played({ score: 0, lines: 0, cuts: 0, bestCut: 0 });
    db.addGame(zero, at);
    assert.equal(db.add(claim({ name: 'BOB', session: zero.session }), at), null);
    assert.deepEqual(db.board('cut', null, 10), []);
    db.close();
  });

  test('removing scores keeps the games but drops the link and the name', () => {
    const db = new ScoreDb(':memory:');
    const a = scoreGame(db, 'ANN', {}, at);
    db.remove(a.id);
    assert.deepEqual({ ...game(db, a.gameId) }, { name: 'ANN', score_id: null });
    const b = scoreGame(db, 'BOB', {}, at);
    assert.equal(db.removeName('BOB'), 1);
    assert.deepEqual({ ...game(db, b.gameId) }, { name: null, score_id: null });
    assert.equal(db.gameTotals(null).games, 2);
    db.close();
  });

  test("a player id ties a player's games together, named or not", () => {
    const db = new ScoreDb(':memory:');
    const ann = 'aaaa0000000000000000000000000000';
    const bob = 'bbbb0000000000000000000000000000';
    const a1 = scoreGame(db, 'ANN', { player: ann }, at).gameId;
    const b1 = db.addGame(played({ player: bob }), at);
    const a2 = db.addGame(played({ player: ann, score: 300 }), new Date(at.getTime() + 60_000));
    db.addGame(played(), at); // an older client: no id

    assert.deepEqual(
      db.gamesByPlayer(ann).map((g) => [g.id, g.name]),
      [
        [a2, null],
        [a1, 'ANN'],
      ],
    );
    assert.deepEqual(
      db.gamesByPlayer('bb').map((g) => g.id),
      [b1],
    );
    assert.deepEqual(db.gamesByPlayer('c'), []);
    assert.equal(db.gameTotals(null).devices, 2);
    db.close();
  });

  test("a score ties its name to its game's player id; INCOGNITO does not", () => {
    const db = new ScoreDb(':memory:');
    const ann = 'aaaa0000000000000000000000000000';
    const phone = 'cccc0000000000000000000000000000';
    const t = (min: number) => new Date(at.getTime() + min * 60_000);
    scoreGame(db, 'ANN', { player: ann }, t(0));
    scoreGame(db, 'ANN', { player: ann, score: 700 }, t(5));
    scoreGame(db, 'ANNIE', { player: ann }, t(10));
    scoreGame(db, 'ANN', { player: phone }, t(20));
    scoreGame(db, 'INCOGNITO', { player: ann }, t(30));
    scoreGame(db, 'ANN', {}, t(40)); // a game with no id: no pair

    const pairs = (rows: Record<string, unknown>[]) => rows.map((r) => [r.player, r.name, r.scores, r.first_at, r.last_at]);
    assert.deepEqual(pairs(db.namesOf('aaaa')), [
      [ann, 'ANNIE', 1, t(10).getTime(), t(10).getTime()],
      [ann, 'ANN', 2, t(0).getTime(), t(5).getTime()],
    ]);
    assert.deepEqual(
      db.playersOf('ANN').map((r) => r.player),
      [phone, ann],
    );
    assert.deepEqual(db.playersOf('INCOGNITO'), []);
    assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM score WHERE player = ?').get(ann)!.n, 4); // INCOGNITO's score keeps the id

    db.removeName('ANN');
    assert.deepEqual(db.playersOf('ANN'), []);
    assert.deepEqual(
      db.namesOf(ann).map((r) => r.name),
      ['ANNIE'],
    );
    db.close();
  });

  test('totals and days', () => {
    const db = new ScoreDb(':memory:');
    assert.deepEqual(
      { ...db.gameTotals(null) },
      { games: 0, named: 0, players: 0, devices: 0, lines: 0, pieces: 0, playMs: 0, best: 0, avgScore: 0 },
    );
    const lastWeek = new Date('2026-11-10T12:00:00Z');
    db.addGame(played({ score: 900, lines: 9, pieces: 30, cuts: 3, bestCut: 3 }), lastWeek);
    scoreGame(db, 'ANN', {}, at);
    scoreGame(db, 'ANN', { score: 200 }, at);
    db.addGame(played({ score: 0, lines: 0, cuts: 0, bestCut: 0, pieces: 10 }), at);

    assert.deepEqual(
      { ...db.gameTotals(null) },
      { games: 4, named: 2, players: 1, devices: 0, lines: 17, pieces: 64, playMs: 240_000, best: 900, avgScore: 400 },
    );
    const week = db.gameTotals(weekStart(at));
    assert.equal(week.games, 3);
    assert.equal(week.best, 500);
    assert.deepEqual(
      db.gamesByDay(lastWeek).map((d) => [d.day, d.games, d.named]),
      [
        ['2026-11-18', 3, 2],
        ['2026-11-10', 1, 0],
      ],
    );
    db.close();
  });
});

test('the week starts on Monday 00:00 UTC', () => {
  assert.equal(weekStart(new Date('2026-11-18T15:30:00Z')).toISOString(), '2026-11-16T00:00:00.000Z'); // Wednesday
  assert.equal(weekStart(new Date('2026-11-16T00:00:00Z')).toISOString(), '2026-11-16T00:00:00.000Z'); // Monday
  assert.equal(weekStart(new Date('2026-11-22T23:59:59Z')).toISOString(), '2026-11-16T00:00:00.000Z'); // Sunday
  assert.equal(weekStart(new Date('2027-01-01T12:00:00Z')).toISOString(), '2026-12-28T00:00:00.000Z'); // across a year
});

describe('boards', () => {
  const db = new ScoreDb(':memory:');
  const lastWeek = new Date('2026-11-10T12:00:00Z');
  const thisWeek = new Date('2026-11-17T12:00:00Z');
  const since = weekStart(new Date('2026-11-18T12:00:00Z'));

  before(() => {
    scoreGame(db, 'ANN', { score: 900 }, lastWeek);
    scoreGame(db, 'ANN', { score: 300 }, thisWeek);
    scoreGame(db, 'BOB', { score: 400 }, thisWeek);
    scoreGame(db, 'BOB', { score: 350 }, thisWeek);
    scoreGame(db, 'CY', { score: 400 }, new Date(thisWeek.getTime() + 1000));
  });

  test('all time: one row per player, their best, ties to whoever was first', () => {
    const b = db.board('cut', null, 10);
    assert.deepEqual(
      b.map((e) => [e.rank, e.name, e.score]),
      [
        [1, 'ANN', 900],
        [2, 'BOB', 400],
        [3, 'CY', 400],
      ],
    );
  });

  test('this week only counts this week', () => {
    assert.deepEqual(
      db.board('cut', since, 10).map((e) => [e.name, e.score]),
      [
        ['BOB', 400],
        ['CY', 400],
        ['ANN', 300],
      ],
    );
  });

  test('the limit applies', () => {
    assert.equal(db.board('cut', null, 2).length, 2);
  });

  test('rank of a player', () => {
    assert.equal(db.rank('cut', 'ANN', null), 1);
    assert.equal(db.rank('cut', 'ANN', since), 3);
    assert.equal(db.rank('cut', 'CY', since), 1); // tied with BOB: same rank
    assert.equal(db.rank('cut', 'NOBODY', null), null);
  });
});

interface Boards {
  name: string;
  weekRank: number;
  allTimeRank: number;
  weekStart: string;
  week: { name: string; score: number }[];
  allTime: { name: string; score: number }[];
}

test('migrating an old database drops Stack scores and keeps Cut ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt2-migrate-'));
  try {
    const file = join(dir, 'scores.db');
    // The schema as it shipped with Stack, at user_version 1
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE score (
        id INTEGER PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('cut', 'stack')), name TEXT NOT NULL,
        score INTEGER NOT NULL, lines INTEGER NOT NULL, level INTEGER NOT NULL, pieces INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO score VALUES (1, 'cut', 'ANN', 500, 4, 0, 12, 60000, 1);
      INSERT INTO score VALUES (2, 'stack', 'BOB', 2300, 0, 0, 23, 60000, 2);
      INSERT INTO score VALUES (3, 'cut', 'CY', 300, 3, 0, 9, 60000, 3);
      PRAGMA user_version = 1;`);
    old.close();

    const db = new ScoreDb(file);
    try {
      assert.deepEqual(
        db.recent(10).map((r) => [r.id, r.mode, r.name]),
        [
          [3, 'cut', 'CY'],
          [1, 'cut', 'ANN'],
        ],
      );
      assert.throws(
        () =>
          db.sql.exec(`INSERT INTO score (id, mode, name, score, lines, level, pieces, duration_ms, created_at)
                       VALUES (4, 'stack', 'DEE', 100, 0, 0, 1, 1000, 4)`),
        /CHECK/,
      );
      const indexes = db.sql.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'score' ORDER BY name`).all();
      assert.deepEqual(
        indexes.map((r) => r.name),
        ['score_by_mode_name', 'score_by_mode_score', 'score_by_mode_time', 'score_by_player'],
      );
      assert.equal(db.gameTotals(null).games, 0); // the game log starts empty
      assert.equal(scoreGame(db, 'EVE', {}, new Date(5)).id, 4); // ids carry on
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrating renames the old shared ANON scores and games to INCOGNITO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt2-migrate-'));
  try {
    const file = join(dir, 'scores.db');
    // A database from before the rename, at user_version 5
    const old = new ScoreDb(file);
    old.sql.exec(`DROP TABLE game_start;
                  DROP INDEX game_by_session; ALTER TABLE game DROP COLUMN session; DROP TABLE session;
                  INSERT INTO score (mode, name, score, lines, level, pieces, duration_ms, created_at)
                  VALUES ('cut', 'ANN', 500, 4, 0, 12, 60000, 1), ('cut', 'ANON', 500, 4, 0, 12, 60000, 2);
                  INSERT INTO game (mode, name, score, lines, level, pieces, cuts, best_cut, duration_ms, created_at)
                  VALUES ('cut', 'ANON', 500, 4, 0, 12, 2, 2, 60000, 2), ('cut', NULL, 100, 1, 0, 4, 1, 1, 9000, 3);
                  ALTER TABLE game DROP COLUMN t_spins;
                  ALTER TABLE game DROP COLUMN t_spin_points;
                  ALTER TABLE match DROP COLUMN host_t_spins;
                  ALTER TABLE match DROP COLUMN host_t_spin_points;
                  ALTER TABLE match DROP COLUMN guest_t_spins;
                  ALTER TABLE match DROP COLUMN guest_t_spin_points;
                  PRAGMA user_version = 5;`);
    old.close();

    const db = new ScoreDb(file);
    try {
      assert.deepEqual(
        db.recent(10).map((r) => r.name),
        ['INCOGNITO', 'ANN'],
      );
      assert.deepEqual(
        db.sql.prepare('SELECT name FROM game ORDER BY created_at').all().map((r) => r.name),
        ['INCOGNITO', null],
      );
      // Games from before T-spins have none
      assert.deepEqual(
        db.sql.prepare('SELECT t_spins, t_spin_points FROM game').all().map((r) => [r.t_spins, r.t_spin_points]),
        [
          [0, 0],
          [0, 0],
        ],
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('http', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slicefall-test-'));
  const db = new ScoreDb(':memory:');
  let base = '';
  let server: ReturnType<typeof createApp>;
  /** The server's clock, unix ms: moved forward to let games take their time. */
  let clock = Date.parse('2026-11-18T12:00:00Z');

  before(async () => {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Slicefall</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1);'.repeat(200));
    server = createApp({
      db,
      staticDir: dir,
      addressHeader: 'x-forwarded-for',
      rateLimit: { max: 3, windowMs: 60_000 },
      gameRateLimit: { max: 4, windowMs: 60_000 },
      sessionRateLimit: { max: 6, windowMs: 60_000 },
      statsPassword: 'hunter2',
      statsRateLimit: { max: 2, windowMs: 60_000 },
      now: () => new Date(clock),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, ip = '10.0.0.1') =>
    fetch(`${base}/api/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.4, ${ip}` },
      body: JSON.stringify(body),
    });

  const postGame = (body: unknown, ip = '10.0.0.1') =>
    fetch(`${base}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.4, ${ip}` },
      body: JSON.stringify(body),
    });

  const start = async (player?: string, ip = '10.0.0.1') => {
    const r = await fetch(`${base}/api/games/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.4, ${ip}` },
      body: JSON.stringify(player ? { player } : {}),
    });
    return { status: r.status, session: ((await r.json()) as { session: string }).session };
  };

  /** Starts a session, lets the game's time pass and logs it. Returns the session to score with. */
  const playGame = async (over: Partial<GameRecord> = {}, ip = '10.0.0.1') => {
    const { session } = await start(over.player, ip);
    const g = played({ ...over, session });
    clock += g.durationMs;
    const r = await postGame(g, ip);
    assert.equal(r.status, 201, await r.clone().text());
    return { session, id: ((await r.json()) as { id: number }).id };
  };

  /** A whole game, logged and scored under `name` from the address `ip`. */
  const scoreGame = async (name: string, ip = '10.0.0.1', over: Partial<GameRecord> = {}) =>
    post({ mode: 'cut', name, session: (await playGame(over, `${ip}0`)).session }, ip);

  test('the stats page wants the password, then lists everything', async () => {
    const basic = (pw: string, ip: string) => ({
      Authorization: `Basic ${Buffer.from(`any:${pw}`).toString('base64')}`,
      'X-Forwarded-For': ip,
    });
    const none = await fetch(`${base}/stats`);
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Basic /);
    assert.equal((await fetch(`${base}/stats`, { headers: basic('wrong', '10.9.9.9') })).status, 401);
    assert.equal((await fetch(`${base}/stats`, { headers: basic('wrong', '10.9.9.9') })).status, 401);
    assert.equal((await fetch(`${base}/stats`, { headers: basic('hunter2', '10.9.9.9') })).status, 429); // too many wrong tries
    const ok = await fetch(`${base}/stats`, { headers: basic('hunter2', '10.9.9.8') });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store, private');
    const html = await ok.text();
    assert.match(html, /Slicefall stats/);
    assert.match(html, /Games started/);
    assert.match(html, /<svg/);
  });

  test('health check', async () => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'ok');
  });

  test('serves the game, with long caching only for hashed assets', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    // Framable only by itch.io (itch/index.html), nowhere else
    assert.match(
      page.headers.get('content-security-policy')!,
      /frame-ancestors https:\/\/itch\.io https:\/\/\*\.itch\.io https:\/\/\*\.itch\.zone(;|$)/,
    );

    const js = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control')!, /immutable/);

    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/assets/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  });

  test('gzips text when the client accepts it', async () => {
    const { request } = await import('node:http');
    const res = await new Promise<import('node:http').IncomingMessage>((resolve) =>
      request(`${base}/assets/app-abc123.js`, { headers: { 'Accept-Encoding': 'gzip' } }, resolve).end(),
    );
    assert.equal(res.headers['content-encoding'], 'gzip');
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    assert.equal(gunzipSync(Buffer.concat(chunks)).toString(), 'console.log(1);'.repeat(200));
  });

  test('a score goes in and comes back on both boards', async () => {
    const r = await scoreGame(' zed ');
    assert.equal(r.status, 201);
    const body = (await r.json()) as Boards;
    assert.equal(body.name, 'ZED');
    assert.equal(body.weekRank, 1);
    assert.equal(body.allTimeRank, 1);
    assert.equal(body.week[0].name, 'ZED');
    assert.equal(body.allTime[0].score, 500);
    assert.equal(body.weekStart, '2026-11-16T00:00:00.000Z');

    const board = (await (await fetch(`${base}/api/leaderboard?mode=cut`)).json()) as Boards;
    assert.equal(board.week[0].name, 'ZED');
    assert.equal('stats' in board, false);
    assert.equal((await fetch(`${base}/api/leaderboard?mode=stack`)).status, 400);
  });

  test('every game is logged, and a submitted score names its game', async () => {
    const skipped = await playGame({ score: 0, lines: 0, cuts: 0, bestCut: 0 }, '10.1.1.1');
    const player = 'feed0000000000000000000000000000';
    const { session, id } = await playGame({ player }, '10.1.1.1');
    assert.ok(id > skipped.id);
    assert.equal(db.sql.prepare('SELECT player FROM game WHERE id = ?').get(id)!.player, player);

    assert.equal((await post({ mode: 'cut', name: 'logged', session }, '10.1.1.1')).status, 201);
    assert.deepEqual(
      db.playersOf('LOGGED').map((r) => r.player),
      [player],
    );
    const rows = db.sql.prepare('SELECT id, name FROM game WHERE id IN (?, ?) ORDER BY id').all(skipped.id, id);
    assert.deepEqual(
      rows.map((g) => [g.id, g.name]),
      [
        [skipped.id, null],
        [id, 'LOGGED'],
      ],
    );
  });

  test('a game is logged once, against a session of its own player, after its time has passed', async () => {
    const ip = '10.2.2.2';
    const ann = 'aaaa0000000000000000000000000000';

    // Logged right away, a minute's game is refused, and its session is used up
    let { session } = await start(undefined, ip);
    clock += 1000;
    let r = await postGame(played({ session }), ip);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /longer than its session/);
    clock += 60_000;
    assert.equal((await postGame(played({ session }), ip)).status, 400);

    // A game may report up to SESSION_SLACK_MS more than the session's age
    ({ session } = await start(undefined, ip));
    clock += 52_000;
    assert.equal((await postGame(played({ session }), ip)).status, 201);
    assert.equal((await postGame(played({ session }), ip)).status, 400); // only once

    // A session started for one player id doesn't log another's game
    ({ session } = await start(ann, ip));
    clock += 60_000;
    assert.equal((await postGame(played({ session, player: 'bbbb0000000000000000000000000000' }), ip)).status, 400);

    // Made-up and expired sessions log nothing
    assert.equal((await postGame(played({ session: 'ab'.repeat(16) }), '10.2.2.3')).status, 400);
    ({ session } = await start(undefined, '10.2.2.3'));
    clock += SESSION_MAX_AGE_MS;
    assert.equal((await postGame(played({ session }), '10.2.2.3')).status, 400);
  });

  test('a score needs a logged game, and gets the numbers the game was logged with', async () => {
    const ip = '10.3.3.3';
    // A started but unlogged game, or a made-up session, can't be scored
    const { session: unlogged } = await start(undefined, `${ip}0`);
    assert.equal((await post({ mode: 'cut', name: 'FAKE', session: unlogged }, ip)).status, 400);
    assert.equal((await post({ mode: 'cut', name: 'FAKE', session: 'cd'.repeat(16) }, ip)).status, 400);

    const { session } = await playGame({ score: 380, lines: 3, cuts: 1, bestCut: 3, pieces: 9 }, `${ip}0`);
    const r = await post({ mode: 'cut', name: 'REAL', session, score: 99_999_999, lines: 50 }, ip);
    assert.equal(r.status, 201);
    const body = (await r.json()) as Boards;
    assert.deepEqual(
      body.allTime.filter((e) => e.name === 'REAL').map((e) => e.score),
      [380],
    );
    assert.equal((await post({ mode: 'cut', name: 'AGAIN', session }, ip)).status, 400);
    assert.equal(db.board('cut', null, 100).filter((e) => e.name === 'FAKE' || e.name === 'AGAIN').length, 0);
  });

  test('bad game records are refused', async () => {
    const { session } = await start(undefined, '10.4.4.4');
    assert.equal((await postGame(played({ cuts: 0, session }))).status, 400);
    assert.equal((await postGame({ ...played({ session }), mode: 'stack' })).status, 400);
    assert.equal((await postGame({ ...played({ session }), player: 'not-an-id' })).status, 400);
    assert.equal((await postGame({ ...played(), session: undefined })).status, 400);
    assert.equal((await post({ mode: 'cut', name: 'ANN', session: 'x' })).status, 400);
    assert.equal((await post({ mode: 'cut', name: 'ANN', gameId: 1 })).status, 400);
    assert.equal((await fetch(`${base}/api/games`)).status, 405);
    assert.equal((await fetch(`${base}/api/games`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/games/start`)).status, 405);
    const badStart = await fetch(`${base}/api/games/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: 'not-an-id' }),
    });
    assert.equal(badStart.status, 400);
    const broken = await fetch(`${base}/api/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(broken.status, 400);
  });

  test('too many sessions or games from one address are refused, apart from the score limit', async () => {
    const ip = '10.7.7.7';
    const sessions: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await start(undefined, ip);
      assert.equal(r.status, 201);
      sessions.push(r.session);
    }
    assert.equal((await start(undefined, ip)).status, 429);
    clock += 60_000;
    for (let i = 0; i < 4; i++) assert.equal((await postGame(played({ session: sessions[i] }), ip)).status, 201);
    assert.equal((await postGame(played({ session: sessions[4] }), ip)).status, 429);
    assert.equal((await post({ mode: 'cut', name: 'STILL', session: sessions[0] }, ip)).status, 201);
  });

  test('bad requests are refused', async () => {
    assert.equal((await fetch(`${base}/api/leaderboard?mode=versus`)).status, 400);
    assert.equal((await fetch(`${base}/api/scores`)).status, 405);
    const notJson = await fetch(`${base}/api/scores`, { method: 'POST', body: 'name=x' });
    assert.equal(notJson.status, 415);
    const huge = await fetch(`${base}/api/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...claim(), pad: 'x'.repeat(5000) }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  });

  // The games are played first: each moves the clock past the limit's window.
  const ready = async (n: number) => {
    const sessions: string[] = [];
    for (let i = 0; i < n; i++) sessions.push((await playGame({}, `10.6.6.${i}`)).session);
    return sessions;
  };
  const score = (name: string, session: string, ip: string) => post({ mode: 'cut', name, session }, ip);

  test('too many scores from one address are refused', async () => {
    const ip = '10.9.9.9';
    const s = await ready(5);
    for (let i = 0; i < 3; i++) assert.equal((await score(`R${i}`, s[i], ip)).status, 201);
    assert.equal((await score('R9', s[3], ip)).status, 429);
    assert.equal((await score('OTHER', s[4], '10.8.8.8')).status, 201);
  });

  test('IPv6 addresses in one /64 share a limit', async () => {
    const s = await ready(5);
    for (let i = 0; i < 3; i++) assert.equal((await score(`S${i}`, s[i], `2001:db8:1:2::${i + 1}`)).status, 201);
    assert.equal((await score('S9', s[3], '2001:db8:1:2:ffff:ffff:ffff:ffff')).status, 429);
    assert.equal((await score('NEXT', s[4], '2001:db8:1:3::1')).status, 201);
  });
});

describe('rate key', () => {
  test('IPv4 as is, IPv6 by /64', () => {
    assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
    assert.equal(rateKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(rateKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(rateKey('::1'), '0:0:0:0::/64');
    assert.equal(rateKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
  });
});
