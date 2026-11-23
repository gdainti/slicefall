import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANON, type GameRecord, type Mode, SESSION_MAX_AGE_MS, type Submission } from './scores.ts';

export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  lines: number;
  level: number;
  pieces: number;
  /** When this best score was set, ISO 8601 */
  at: string;
}

/**
 * Schema changes, applied in order. PRAGMA user_version remembers how many have run, so add new
 * steps at the end and never edit one that has shipped.
 */
const MIGRATIONS = [
  `CREATE TABLE score (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut', 'stack')),
     name        TEXT    NOT NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   CREATE INDEX score_by_mode_score ON score (mode, score DESC);
   CREATE INDEX score_by_mode_time  ON score (mode, created_at);
   CREATE INDEX score_by_mode_name  ON score (mode, name, score DESC);`,

  // Stack mode was removed: drop its scores and only allow Cut. SQLite can't change a CHECK in
  // place, so the table is rebuilt (dropping it also drops its indexes, which are made again).
  `DELETE FROM score WHERE mode <> 'cut';
   CREATE TABLE score_new (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut')),
     name        TEXT    NOT NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   INSERT INTO score_new (id, mode, name, score, lines, level, pieces, duration_ms, created_at)
     SELECT id, mode, name, score, lines, level, pieces, duration_ms, created_at FROM score;
   DROP TABLE score;
   ALTER TABLE score_new RENAME TO score;
   CREATE INDEX score_by_mode_score ON score (mode, score DESC);
   CREATE INDEX score_by_mode_time  ON score (mode, created_at);
   CREATE INDEX score_by_mode_name  ON score (mode, name, score DESC);`,

  // Every finished game, scored or skipped, for play statistics. A game gets the player's name
  // (and its leaderboard row) only when they submit the score; NULL means they skipped or had none.
  `CREATE TABLE game (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut')),
     name        TEXT,
     score_id    INTEGER REFERENCES score (id) ON DELETE SET NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     cuts        INTEGER NOT NULL,
     best_cut    INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   CREATE INDEX game_by_time  ON game (created_at);
   CREATE INDEX game_by_score ON game (score_id);`,

  // A random id the browser keeps, so one player's games and scores can be followed, named or not.
  // NULL for rows from before it existed, or sent by a client without it. player_name ties each id
  // to the names it has submitted scores under (not the shared ANON), and a name to its ids.
  `ALTER TABLE game ADD COLUMN player TEXT;
   CREATE INDEX game_by_player ON game (player, created_at);
   ALTER TABLE score ADD COLUMN player TEXT;
   CREATE INDEX score_by_player ON score (player);
   CREATE TABLE player_name (
     player   TEXT    NOT NULL,
     name     TEXT    NOT NULL,
     scores   INTEGER NOT NULL, -- scores submitted with this id and name
     first_at INTEGER NOT NULL, -- unix ms
     last_at  INTEGER NOT NULL, -- unix ms
     PRIMARY KEY (player, name)
   ) WITHOUT ROWID;
   CREATE INDEX player_name_by_name ON player_name (name);`,

  // Online Versus: one row per round the server started, written when it ends. The host created
  // the room, the guest joined it; their ids are the browsers' player ids (NULL if not sent).
  // Scores are NULL for a player who hadn't topped out when the round ended early.
  `CREATE TABLE match (
     id          INTEGER PRIMARY KEY,
     room        TEXT    NOT NULL, -- random id of the room (its code is reused once it closes)
     round       INTEGER NOT NULL, -- 1, then 2 for the first rematch, ...
     host        TEXT,
     guest       TEXT,
     host_score  INTEGER,
     guest_score INTEGER,
     winner      TEXT    CHECK (winner IN ('host', 'guest', 'draw')),
     ended       TEXT    NOT NULL CHECK (ended IN ('finished', 'host-left', 'guest-left', 'restart')),
     duration_ms INTEGER NOT NULL, -- from the round's start to its end, by the server's clock
     created_at  INTEGER NOT NULL  -- unix ms, when it ended
   );
   CREATE INDEX match_by_time  ON match (created_at);
   CREATE INDEX match_by_host  ON match (host);
   CREATE INDEX match_by_guest ON match (guest);`,

  // The shared name for scores sent without one was ANON and is INCOGNITO now (scores.ts). Older
  // rows follow it, so anonymous play keeps a single board row. Nobody could submit ANON as a name
  // of their own, so every ANON row was anonymous.
  `UPDATE score SET name = 'INCOGNITO' WHERE name = 'ANON';
   UPDATE game  SET name = 'INCOGNITO' WHERE name = 'ANON';`,

  // T-spins: full turns of a falling T, and the points they paid (part of score). 0 for older games.
  `ALTER TABLE game ADD COLUMN t_spins INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE game ADD COLUMN t_spin_points INTEGER NOT NULL DEFAULT 0;`,

  // T-spins of each player of an online round, reported with their score: NULL when the score is,
  // or the client didn't send them.
  `ALTER TABLE match ADD COLUMN host_t_spins INTEGER;
   ALTER TABLE match ADD COLUMN host_t_spin_points INTEGER;
   ALTER TABLE match ADD COLUMN guest_t_spins INTEGER;
   ALTER TABLE match ADD COLUMN guest_t_spin_points INTEGER;`,

  // Game sessions: POST /api/games/start makes one, and a game is only logged against one that is
  // unused and old enough for the play it reports. The game keeps its session id, which is also
  // what its score is claimed with (secret and random, unlike the game's id). Games logged before
  // this have none and can't be scored any more.
  `CREATE TABLE session (
     id         TEXT    PRIMARY KEY,
     player     TEXT,
     started_at INTEGER NOT NULL -- unix ms
   ) WITHOUT ROWID;
   CREATE INDEX session_by_time ON session (started_at);
   ALTER TABLE game ADD COLUMN session TEXT;
   CREATE UNIQUE INDEX game_by_session ON game (session) WHERE session IS NOT NULL;`,

  // Every game started (one row per session), finished or not, kept after its session is used or
  // dropped. Filled from what is known: each logged game started duration_ms before it ended, and
  // each open session is a start. Games abandoned before this aren't known and don't count.
  `CREATE TABLE game_start (
     id         INTEGER PRIMARY KEY,
     player     TEXT,
     started_at INTEGER NOT NULL -- unix ms
   );
   INSERT INTO game_start (player, started_at)
     SELECT player, started_at FROM (
       SELECT player, created_at - duration_ms AS started_at FROM game
       UNION ALL SELECT player, started_at FROM session
     ) ORDER BY started_at;
   CREATE INDEX game_start_by_time   ON game_start (started_at);
   CREATE INDEX game_start_by_player ON game_start (player);`,
];

/** A game session as taken (and so used up) by ScoreDb.takeSession. */
export interface Session {
  player: string | null;
  startedAt: number;
}

/** A score as stored: the name from the submission, the numbers from its game. */
export interface StoredScore {
  id: number;
  mode: Mode;
  name: string;
  score: number;
}

/** One online Versus round, as server/match.ts reports it. */
export interface MatchRecord {
  room: string;
  round: number;
  host: string | null;
  guest: string | null;
  hostScore: number | null;
  guestScore: number | null;
  /** T-spins of each player and the points they paid (part of the score); null with no score or not sent */
  hostTSpins: number | null;
  hostTSpinPoints: number | null;
  guestTSpins: number | null;
  guestTSpinPoints: number | null;
  /** Who won a finished round (the other player topped out first); null otherwise */
  winner: 'host' | 'guest' | null;
  /** finished: both reported a score (the loser on topping out, the winner when told); host-left / guest-left: who left (or dropped) first; restart: the server stopped */
  ended: 'finished' | 'host-left' | 'guest-left' | 'restart';
  durationMs: number;
}

export interface MatchTotals {
  rounds: number;
  finished: number;
  /** Rounds that ended because a player left */
  left: number;
  rooms: number;
  /** Rounds after the first in their room */
  rematches: number;
  /** Different player ids among hosts and guests */
  devices: number;
  playMs: number;
}

export interface GameTotals {
  games: number;
  /** Games whose score was submitted with a name */
  named: number;
  /** Different names among those */
  players: number;
  /** Different player ids (browsers) among all the games */
  devices: number;
  lines: number;
  pieces: number;
  playMs: number;
  best: number;
  avgScore: number;
}

/** Games started and names on the board, for the stats page and admin notes. */
export interface BoardStats {
  /** Games started, finished or not */
  started: number;
  /** Different names with a score on the board (not the shared ANON) */
  names: number;
}

export class ScoreDb {
  readonly sql: DatabaseSync;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const { user_version: done } = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = done; i < MIGRATIONS.length; i++) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[i]);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
        this.sql.exec('COMMIT');
      } catch (e) {
        this.sql.exec('ROLLBACK');
        throw e;
      }
    }
  }

  /** Starts a game session and returns its id. Also drops sessions too old to be used. */
  startSession(player: string | null, at: Date): string {
    this.sql.prepare('DELETE FROM session WHERE started_at <= ?').run(at.getTime() - SESSION_MAX_AGE_MS);
    const id = randomBytes(16).toString('hex');
    this.sql.prepare('INSERT INTO session (id, player, started_at) VALUES (?, ?, ?)').run(id, player, at.getTime());
    this.sql.prepare('INSERT INTO game_start (player, started_at) VALUES (?, ?)').run(player, at.getTime());
    return id;
  }

  /** Removes a session and returns it, or null when there is none (never started, used or expired). */
  takeSession(id: string, at: Date): Session | null {
    const row = this.sql.prepare('DELETE FROM session WHERE id = ? RETURNING player, started_at').get(id) as
      | { player: string | null; started_at: number }
      | undefined;
    if (!row || row.started_at <= at.getTime() - SESSION_MAX_AGE_MS) return null;
    return { player: row.player, startedAt: row.started_at };
  }

  /**
   * Adds a leaderboard score for the logged game with this session, if it has none yet and scored
   * something. The numbers are the game's. The game gets the name, and with a player id (and a name
   * of their own, not ANON) the pair is recorded. Null when there is no such game to score.
   */
  add(s: Submission, at: Date): StoredScore | null {
    this.sql.exec('BEGIN');
    try {
      const g = this.sql
        .prepare(
          `SELECT id, mode, player, score, lines, level, pieces, duration_ms FROM game
           WHERE session = ? AND mode = ? AND score_id IS NULL AND name IS NULL AND score > 0`,
        )
        .get(s.session, s.mode) as
        | { id: number; mode: Mode; player: string | null; score: number; lines: number; level: number; pieces: number; duration_ms: number }
        | undefined;
      if (!g) {
        this.sql.exec('ROLLBACK');
        return null;
      }
      const r = this.sql
        .prepare(
          `INSERT INTO score (mode, name, player, score, lines, level, pieces, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(g.mode, s.name, g.player, g.score, g.lines, g.level, g.pieces, g.duration_ms, at.getTime());
      const id = Number(r.lastInsertRowid);
      this.sql.prepare('UPDATE game SET name = ?, score_id = ? WHERE id = ?').run(s.name, id, g.id);
      if (g.player !== null && s.name !== ANON) {
        this.sql
          .prepare(
            `INSERT INTO player_name (player, name, scores, first_at, last_at) VALUES (?, ?, 1, ?, ?)
             ON CONFLICT (player, name) DO UPDATE SET scores = scores + 1, last_at = excluded.last_at`,
          )
          .run(g.player, s.name, at.getTime(), at.getTime());
      }
      this.sql.exec('COMMIT');
      return { id, mode: g.mode, name: s.name, score: g.score };
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  /** The names a player id has submitted scores under, most recent first (for the admin script). */
  namesOf(prefix: string) {
    return this.sql
      .prepare(
        `SELECT player, name, scores, first_at, last_at FROM player_name
         WHERE player >= ? AND player < ? ORDER BY last_at DESC`,
      )
      .all(prefix, `${prefix}g`);
  }

  /** The player ids a name has been submitted from, most recent first (for the admin script). */
  playersOf(name: string) {
    return this.sql
      .prepare(
        `SELECT player, name, scores, first_at, last_at FROM player_name
         WHERE name = ? ORDER BY last_at DESC`,
      )
      .all(name);
  }

  /** Logs a finished game, scored or not. Its session should have been taken (takeSession) first. */
  addGame(g: GameRecord, at: Date): number {
    const r = this.sql
      .prepare(
        `INSERT INTO game (mode, player, session, score, lines, level, pieces, cuts, best_cut, t_spins, t_spin_points, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(g.mode, g.player ?? null, g.session, g.score, g.lines, g.level, g.pieces, g.cuts, g.bestCut, g.tSpins, g.tSpinPoints, g.durationMs, at.getTime());
    return Number(r.lastInsertRowid);
  }

  /** Logs an online Versus round. Rounds logged before the first-to-top-out rule may say 'draw'. */
  addMatch(m: MatchRecord, at: Date): number {
    const winner = m.ended === 'finished' ? m.winner : null;
    const r = this.sql
      .prepare(
        `INSERT INTO match (room, round, host, guest, host_score, guest_score, host_t_spins, host_t_spin_points,
                            guest_t_spins, guest_t_spin_points, winner, ended, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.room,
        m.round,
        m.host,
        m.guest,
        m.hostScore,
        m.guestScore,
        m.hostTSpins,
        m.hostTSpinPoints,
        m.guestTSpins,
        m.guestTSpinPoints,
        winner,
        m.ended,
        m.durationMs,
        at.getTime(),
      );
    return Number(r.lastInsertRowid);
  }

  /** Totals over the online rounds since `since` (or ever). */
  matchTotals(since: Date | null): MatchTotals {
    return this.sql
      .prepare(
        `SELECT COUNT(*) AS rounds, COUNT(*) FILTER (WHERE ended = 'finished') AS finished,
                COUNT(*) FILTER (WHERE ended <> 'finished') AS "left", COUNT(DISTINCT room) AS rooms,
                COUNT(*) FILTER (WHERE round > 1) AS rematches,
                (SELECT COUNT(*) FROM (SELECT host AS p FROM match WHERE created_at >= ?1 AND host IS NOT NULL
                                       UNION SELECT guest FROM match WHERE created_at >= ?1 AND guest IS NOT NULL)) AS devices,
                COALESCE(SUM(duration_ms), 0) AS playMs
         FROM match WHERE created_at >= ?1`,
      )
      .get(since?.getTime() ?? 0) as unknown as MatchTotals;
  }

  /** The latest online rounds, newest first (for the admin script). */
  recentMatches(limit: number) {
    return this.sql
      .prepare(
        `SELECT id, room, round, host, guest, host_score, guest_score, host_t_spins, guest_t_spins, winner, ended, duration_ms, created_at
         FROM match ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Online rounds of the player ids starting with `prefix`, as host or guest, newest first. */
  matchesByPlayer(prefix: string) {
    return this.sql
      .prepare(
        `SELECT id, room, round, host, guest, host_score, guest_score, host_t_spins, guest_t_spins, winner, ended, duration_ms, created_at
         FROM match WHERE (host >= ?1 AND host < ?2) OR (guest >= ?1 AND guest < ?2)
         ORDER BY created_at DESC, id DESC`,
      )
      .all(prefix, `${prefix}g`);
  }

  /** Totals over the game log since `since` (or ever). */
  gameTotals(since: Date | null): GameTotals {
    return this.sql
      .prepare(
        `SELECT COUNT(*) AS games, COUNT(name) AS named, COUNT(DISTINCT name) AS players,
                COUNT(DISTINCT player) AS devices,
                COALESCE(SUM(lines), 0) AS lines, COALESCE(SUM(pieces), 0) AS pieces,
                COALESCE(SUM(duration_ms), 0) AS playMs, COALESCE(MAX(score), 0) AS best,
                COALESCE(ROUND(AVG(score)), 0) AS avgScore
         FROM game WHERE created_at >= ?`,
      )
      .get(since?.getTime() ?? 0) as unknown as GameTotals;
  }

  /** Games started and names on the board since `since` (or ever). */
  boardStats(mode: Mode, since: Date | null): BoardStats {
    const from = since?.getTime() ?? 0;
    const { started } = this.sql.prepare('SELECT COUNT(*) AS started FROM game_start WHERE started_at >= ?').get(from) as {
      started: number;
    };
    const { names } = this.sql
      .prepare('SELECT COUNT(DISTINCT name) AS names FROM score WHERE mode = ? AND created_at >= ? AND name <> ?')
      .get(mode, from, ANON) as { names: number };
    return { started, names };
  }

  /**
   * Player ids that started the most games since `since` (or ever), with the names they have
   * submitted scores under, most used first (for the admin script; names are never public here).
   */
  topStarters(since: Date | null, limit: number) {
    return this.sql
      .prepare(
        `SELECT s.player, s.started,
                (SELECT COUNT(*) FROM game g WHERE g.player = s.player AND g.created_at >= ?1) AS finished,
                (SELECT COALESCE(MAX(score), 0) FROM game g WHERE g.player = s.player AND g.created_at >= ?1) AS best,
                (SELECT group_concat(name, ', ') FROM (SELECT name FROM player_name p WHERE p.player = s.player
                                                       ORDER BY scores DESC, last_at DESC)) AS names,
                s.last_at
         FROM (SELECT player, COUNT(*) AS started, MAX(started_at) AS last_at FROM game_start
               WHERE started_at >= ?1 AND player IS NOT NULL GROUP BY player) s
         ORDER BY s.started DESC, s.last_at DESC LIMIT ?2`,
      )
      .all(since?.getTime() ?? 0, limit);
  }

  /** Starts, logged games, devices and play per UTC day since `since`, oldest day first (for /stats). */
  activityByDay(since: Date) {
    return this.sql
      .prepare(
        `WITH s AS (SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS started,
                           COUNT(DISTINCT player) AS devices
                    FROM game_start WHERE started_at >= ?1 GROUP BY day),
              g AS (SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS finished, COUNT(name) AS named,
                           COALESCE(MAX(score), 0) AS best, ROUND(SUM(duration_ms) / 60000.0) AS minutes
                    FROM game WHERE created_at >= ?1 GROUP BY day)
         SELECT d.day, COALESCE(s.started, 0) AS started, COALESCE(s.devices, 0) AS devices,
                COALESCE(g.finished, 0) AS finished, COALESCE(g.named, 0) AS named,
                COALESCE(g.best, 0) AS best, COALESCE(g.minutes, 0) AS minutes
         FROM (SELECT day FROM s UNION SELECT day FROM g) d
         LEFT JOIN s USING (day) LEFT JOIN g USING (day) ORDER BY d.day`,
      )
      .all(since.getTime()) as {
      day: string;
      started: number;
      devices: number;
      finished: number;
      named: number;
      best: number;
      minutes: number;
    }[];
  }

  /** Games started per UTC hour of the day, ever (0-23; hours without any are left out). */
  startsByHour() {
    return this.sql
      .prepare(
        `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS started
         FROM game_start GROUP BY hour ORDER BY hour`,
      )
      .all() as { hour: number; started: number }[];
  }

  /** Different player ids (browsers) that have started or logged a game. */
  deviceCount(): number {
    return (
      this.sql
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT player FROM game_start WHERE player IS NOT NULL
                                      UNION SELECT player FROM game WHERE player IS NOT NULL)`,
        )
        .get() as { n: number }
    ).n;
  }

  /** Every logged game's score, for a histogram. */
  allScores(): number[] {
    return (this.sql.prepare('SELECT score FROM game').all() as { score: number }[]).map((r) => r.score);
  }

  /** Every player id seen, most recently active first, with what they did (for /stats). */
  players(limit: number) {
    return this.sql
      .prepare(
        `WITH ids AS (SELECT player FROM game_start WHERE player IS NOT NULL
                      UNION SELECT player FROM game WHERE player IS NOT NULL)
         SELECT ids.player,
                (SELECT COUNT(*) FROM game_start s WHERE s.player = ids.player) AS started,
                (SELECT COUNT(*) FROM game g WHERE g.player = ids.player) AS finished,
                (SELECT COUNT(*) FROM game g WHERE g.player = ids.player AND g.score_id IS NOT NULL) AS scored,
                (SELECT COALESCE(MAX(score), 0) FROM game g WHERE g.player = ids.player) AS best,
                (SELECT COALESCE(SUM(duration_ms), 0) FROM game g WHERE g.player = ids.player) AS play_ms,
                (SELECT COUNT(*) FROM match m WHERE m.host = ids.player OR m.guest = ids.player) AS online,
                (SELECT group_concat(name, ', ') FROM (SELECT name FROM player_name p WHERE p.player = ids.player
                                                       ORDER BY scores DESC, last_at DESC)) AS names,
                MIN((SELECT MIN(started_at) FROM game_start s WHERE s.player = ids.player),
                    COALESCE((SELECT MIN(created_at) FROM game g WHERE g.player = ids.player), 1e18)) AS first_at,
                MAX((SELECT COALESCE(MAX(started_at), 0) FROM game_start s WHERE s.player = ids.player),
                    COALESCE((SELECT MAX(created_at) FROM game g WHERE g.player = ids.player), 0)) AS last_at
         FROM ids ORDER BY last_at DESC LIMIT ?`,
      )
      .all(limit) as {
      player: string;
      started: number;
      finished: number;
      scored: number;
      best: number;
      play_ms: number;
      online: number;
      names: string | null;
      first_at: number;
      last_at: number;
    }[];
  }

  /** Every name on the board, best first: its scores and the player ids it came from (for /stats). */
  names() {
    return this.sql
      .prepare(
        `SELECT name, MAX(score) AS best, COUNT(*) AS scores, COUNT(DISTINCT player) AS devices,
                MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM score GROUP BY name ORDER BY best DESC, first_at ASC`,
      )
      .all() as { name: string; best: number; scores: number; devices: number; first_at: number; last_at: number }[];
  }

  /** Games per UTC day since `since`, newest day first. */
  gamesByDay(since: Date) {
    return this.sql
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS games, COUNT(name) AS named,
                SUM(lines) AS lines, MAX(score) AS best, ROUND(SUM(duration_ms) / 60000.0) AS minutes
         FROM game WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
      )
      .all(since.getTime());
  }

  /** The latest games, newest first (for the admin script). */
  recentGames(limit: number) {
    return this.sql
      .prepare(
        `SELECT id, mode, player, name, score, lines, level, pieces, cuts, best_cut, t_spins, t_spin_points, duration_ms, created_at
         FROM game ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Every game of the player ids starting with `prefix`, newest first (for the admin script). */
  gamesByPlayer(prefix: string) {
    return this.sql
      .prepare(
        `SELECT id, mode, player, name, score, lines, level, pieces, cuts, best_cut, t_spins, t_spin_points, duration_ms, created_at
         FROM game WHERE player >= ? AND player < ? ORDER BY created_at DESC, id DESC`,
      )
      .all(prefix, `${prefix}g`);
  }

  /**
   * One row per player: their best score since `since` (or ever), highest first.
   * Equal scores: whoever got there first ranks higher.
   */
  board(mode: Mode, since: Date | null, limit: number): BoardEntry[] {
    const rows = this.sql
      .prepare(
        `SELECT name, score, lines, level, pieces, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY score DESC, created_at ASC, id ASC) AS n
           FROM score WHERE mode = ? AND created_at >= ?
         ) WHERE n = 1
         ORDER BY score DESC, created_at ASC, name ASC
         LIMIT ?`,
      )
      .all(mode, since?.getTime() ?? 0, limit) as {
      name: string;
      score: number;
      lines: number;
      level: number;
      pieces: number;
      created_at: number;
    }[];
    return rows.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      score: r.score,
      lines: r.lines,
      level: r.level,
      pieces: r.pieces,
      at: new Date(r.created_at).toISOString(),
    }));
  }

  /** A player's place on a board: 1 + the players with a higher best. Null if they have no score there. */
  rank(mode: Mode, name: string, since: Date | null): number | null {
    const from = since?.getTime() ?? 0;
    const mine = this.sql
      .prepare('SELECT MAX(score) AS best FROM score WHERE mode = ? AND name = ? AND created_at >= ?')
      .get(mode, name, from) as { best: number | null };
    if (mine.best === null) return null;
    const above = this.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT MAX(score) AS best FROM score WHERE mode = ? AND created_at >= ? GROUP BY name
         ) WHERE best > ?`,
      )
      .get(mode, from, mine.best) as { n: number };
    return above.n + 1;
  }

  /** Every score a name has, newest first (for the admin script). */
  byName(name: string) {
    return this.sql
      .prepare('SELECT id, mode, name, player, score, lines, created_at FROM score WHERE name = ? ORDER BY created_at DESC')
      .all(name);
  }

  recent(limit: number) {
    return this.sql
      .prepare('SELECT id, mode, name, score, lines, pieces, duration_ms, created_at FROM score ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  remove(id: number): boolean {
    return Number(this.sql.prepare('DELETE FROM score WHERE id = ?').run(id).changes) > 0;
  }

  /** Removes a player's scores and takes their name off their games and ids (the games still count). */
  removeName(name: string): number {
    this.sql.prepare('UPDATE game SET name = NULL WHERE name = ?').run(name);
    this.sql.prepare('DELETE FROM player_name WHERE name = ?').run(name);
    return Number(this.sql.prepare('DELETE FROM score WHERE name = ?').run(name).changes);
  }

  /** A consistent copy of the database while it is in use. */
  backup(to: string) {
    this.sql.prepare('VACUUM INTO ?').run(to);
  }

  ping(): boolean {
    return (this.sql.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  close() {
    this.sql.close();
  }
}
