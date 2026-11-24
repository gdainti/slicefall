// Online Versus rooms. One player creates a room and gets a short code; the other joins with it.
// The server only pairs the two and passes messages between them: each browser runs its own field
// and streams what it looks like to the other, so nothing here knows about the game's physics.
//
// Client -> server (JSON text messages)
//   { t: 'create', player?, attacks?, pieces?, hold? }  first message: open a room (player: the
//                                 browser's random id; attacks: cutting rows sends blocks, the host's
//                                 setting, on unless false; pieces: 'bag' for the 7-bag, otherwise
//                                 random; hold: the hold piece can be used, off unless true)
//   { t: 'join', code, player? }  first message: join a room
//   { t: 'state', ... }           passed on to the other player as is
//   { t: 'attack', n }            this player's cut sends the other n blocks (1 to MAX_ATTACK)
//   { t: 'over', score, tSpins?, tSpinPoints? }  this player's round is over with this score, of
//                                 which tSpinPoints came from tSpins T-spins (for the match log
//                                 only): sent on topping out, or when told 'won'
//   { t: 'rematch' }              after a result: play again
// Server -> client
//   { t: 'room', code }           the room is open, waiting for the other player
//   { t: 'start', seed, round, attacks, pieces, hold }  both are in: start a round with this piece seed
//   { t: 'state', ... }           the other player's field
//   { t: 'attack', n }            blocks from the other player
//   { t: 'won' }                  the other player topped out first: this player wins, so stop
//                                 and report the score with 'over'
//   { t: 'result', you, them, win }  both have reported: the two final scores, and whether this
//                                 player won (whoever topped out first loses)
//   { t: 'rematch' }              the other player wants a rematch
//   { t: 'left' }                 the other player left; the room is gone
//   { t: 'error', error }         'not-found' | 'full' | 'busy' | 'limit', then the server hangs up

import { randomBytes, randomInt } from 'node:crypto';
import type { MatchRecord } from './db.ts';
import { PLAYER_ID } from './scores.ts';
import { CLOSE, type WsConnection } from './ws.ts';

/** No I, L, O, 0 or 1, which are easy to mix up when a code is read out or typed. */
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

/** Most blocks one attack may send (the game's ATTACK_BLOCKS tops out at 5) */
export const MAX_ATTACK = 5;
/**
 * Least time between one player's attacks, ms. A cut takes 1.2 s of blinking before the next piece
 * can land, so a real client never sends faster; this stops a modified one flooding the other.
 */
export const ATTACK_GAP_MS = 1000;

export interface MatchOptions {
  /** Rooms open at once; past this, creating one is refused as 'busy'. */
  maxRooms?: number;
  /** A room nobody joins is closed after this long. */
  waitMs?: number;
  /** A new connection must create or join within this long. */
  helloMs?: number;
  /** Messages one connection may send per second (the game sends 20). */
  maxRate?: number;
  /** Called when a round ends, finished or left early, to log it (server/db.ts) */
  onRound?: (r: MatchRecord) => void;
  /** Clock for round durations, unix ms */
  now?: () => number;
}

type MatchError = 'not-found' | 'full' | 'busy' | 'limit';

interface Player {
  conn: WsConnection;
  /** The browser's random player id, if it sent one */
  id: string | null;
  /** Final score of this round, once topped out */
  score: number | null;
  /** T-spins and their points this round, as reported with the score; null if not (or not believably) */
  tSpins: number | null;
  tSpinPoints: number | null;
  rematch: boolean;
  /** When this player last sent an attack (Date.now()) */
  lastAttack: number;
}

interface Room {
  code: string;
  /** Unique for the match log, where the code (reused later) can't tell rooms apart */
  id: string;
  players: Player[];
  round: number;
  waitTimer: NodeJS.Timeout | null;
  /** When the current round started (unix ms), and whether it has been logged yet */
  startedAt: number;
  logged: boolean;
  /** Cutting rows sends the other player blocks (the host's choice) */
  attacks: boolean;
  /** Who topped out first this round, and so lost it */
  loser: Player | null;
  /** How the seed turns into pieces (the host's choice); random for clients that don't say */
  pieces: 'bag' | 'random';
  /** The hold piece can be used (the host's choice); off for clients that don't say */
  hold: boolean;
}

/** Normalises a typed code: upper case, without spaces or dashes. Null when it can't be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_CHARS.includes(c)) return null;
  return code;
}

export class Matches {
  private rooms = new Map<string, Room>();
  private conns = new Set<WsConnection>();
  private maxRooms: number;
  private waitMs: number;
  private helloMs: number;
  private maxRate: number;
  private onRound: (r: MatchRecord) => void;
  private now: () => number;
  /** Set by closeAll, so rounds cut short by a restart aren't logged as a player leaving */
  private closing = false;

  constructor(opts: MatchOptions = {}) {
    this.maxRooms = opts.maxRooms ?? 1000;
    this.waitMs = opts.waitMs ?? 30 * 60_000;
    this.helloMs = opts.helloMs ?? 10_000;
    this.maxRate = opts.maxRate ?? 100;
    this.onRound = opts.onRound ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Rooms open right now */
  get size(): number {
    return this.rooms.size;
  }

  /**
   * Takes a new connection. `allow` is asked once, when it creates or joins a room, and says whether
   * its address is still within the limit (which keeps codes from being guessed by brute force).
   */
  add(conn: WsConnection, allow: () => boolean) {
    this.conns.add(conn);
    let room: Room | null = null;
    let me: Player | null = null;
    const hello = setTimeout(() => {
      if (!room) conn.close(CLOSE.policy, 'create or join');
    }, this.helloMs);
    hello.unref();

    let second = 0;
    let count = 0;

    const refuse = (error: MatchError) => {
      conn.send(JSON.stringify({ t: 'error', error }));
      conn.close(CLOSE.normal);
    };

    conn.onMessage = (text) => {
      const s = Math.floor(Date.now() / 1000);
      if (s !== second) {
        second = s;
        count = 0;
      }
      if (++count > this.maxRate) return conn.close(CLOSE.policy, 'too many messages');

      let msg: { t?: unknown; [k: string]: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return conn.close(CLOSE.protocol, 'bad message');
      }
      if (!msg || typeof msg !== 'object') return conn.close(CLOSE.protocol, 'bad message');

      if (!room) {
        if (msg.t !== 'create' && msg.t !== 'join') return conn.close(CLOSE.protocol, 'create or join first');
        if (!allow()) return refuse('limit');
        const id = typeof msg.player === 'string' && PLAYER_ID.test(msg.player) ? msg.player : null;
        if (msg.t === 'create') {
          if (this.rooms.size >= this.maxRooms) return refuse('busy');
          me = { conn, id, score: null, tSpins: null, tSpinPoints: null, rematch: false, lastAttack: 0 };
          room = this.open(me, msg.attacks !== false, msg.pieces === 'bag' ? 'bag' : 'random', msg.hold === true);
          conn.send(JSON.stringify({ t: 'room', code: room.code }));
        } else {
          const code = normalizeCode(msg.code);
          const found = code ? this.rooms.get(code) : undefined;
          if (!found) return refuse('not-found');
          if (found.players.length >= 2) return refuse('full');
          me = { conn, id, score: null, tSpins: null, tSpinPoints: null, rematch: false, lastAttack: 0 };
          room = found;
          room.players.push(me);
          if (room.waitTimer) clearTimeout(room.waitTimer);
          room.waitTimer = null;
          this.start(room);
        }
        return;
      }

      const other = room.players.find((p) => p !== me);
      switch (msg.t) {
        case 'state':
          other?.conn.send(text);
          break;
        case 'attack': {
          // Only in a room with attacks on, while both are still playing the round
          const n = msg.n;
          if (!room.attacks || !other || room.startedAt === 0 || me!.score !== null || other.score !== null) break;
          if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_ATTACK) break;
          const at = Date.now();
          if (at - me!.lastAttack < ATTACK_GAP_MS) break;
          me!.lastAttack = at;
          other.conn.send(JSON.stringify({ t: 'attack', n }));
          break;
        }
        case 'over': {
          const score = msg.score;
          if (!Number.isSafeInteger(score) || (score as number) < 0 || me!.score !== null || !other) break;
          me!.score = score as number;
          // Each T-spin pays 1 to 100 points, all part of the score; anything else isn't logged
          const { tSpins, tSpinPoints } = msg;
          if (
            Number.isSafeInteger(tSpins) &&
            Number.isSafeInteger(tSpinPoints) &&
            (tSpinPoints as number) >= (tSpins as number) &&
            (tSpinPoints as number) <= Math.min(score as number, (tSpins as number) * 100)
          ) {
            me!.tSpins = tSpins as number;
            me!.tSpinPoints = tSpinPoints as number;
          }
          if (other.score === null) {
            // The first to top out loses, and the round ends for the other player too
            room.loser = me;
            other.conn.send(JSON.stringify({ t: 'won' }));
          } else {
            this.log(room, 'finished');
            for (const p of room.players) {
              const them = room.players.find((q) => q !== p)!;
              p.conn.send(JSON.stringify({ t: 'result', you: p.score, them: them.score, win: p !== room.loser }));
            }
          }
          break;
        }
        case 'rematch':
          // Only once both have finished the round
          if (!other || room.players.some((p) => p.score === null) || me!.rematch) break;
          me!.rematch = true;
          if (other.rematch) {
            room.round++;
            this.start(room);
          } else other.conn.send(JSON.stringify({ t: 'rematch' }));
          break;
        default:
          break;
      }
    };

    conn.onClose = () => {
      clearTimeout(hello);
      this.conns.delete(conn);
      if (room) this.leave(room, me!);
    };
  }

  /** Ends every connection, e.g. when the server shuts down. */
  closeAll() {
    this.closing = true;
    for (const conn of [...this.conns]) conn.close(CLOSE.goingAway, 'server restarting');
  }

  private open(host: Player, attacks: boolean, pieces: Room['pieces'], hold: boolean): Room {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    } while (this.rooms.has(code));
    const room: Room = {
      code,
      id: randomBytes(6).toString('hex'),
      players: [host],
      round: 1,
      waitTimer: null,
      startedAt: 0,
      logged: false,
      attacks,
      pieces,
      hold,
      loser: null,
    };
    room.waitTimer = setTimeout(() => host.conn.close(CLOSE.normal, 'nobody joined'), this.waitMs);
    room.waitTimer.unref();
    this.rooms.set(code, room);
    return room;
  }

  private start(room: Room) {
    room.startedAt = this.now();
    room.logged = false;
    room.loser = null;
    const seed = randomInt(2 ** 31);
    for (const p of room.players) {
      p.score = null;
      p.tSpins = null;
      p.tSpinPoints = null;
      p.rematch = false;
      p.lastAttack = 0;
      p.conn.send(JSON.stringify({ t: 'start', seed, round: room.round, attacks: room.attacks, pieces: room.pieces, hold: room.hold }));
    }
  }

  /** Reports the current round to the match log, once. A failure to log never ends the game. */
  private log(room: Room, ended: MatchRecord['ended']) {
    if (room.logged || room.startedAt === 0) return;
    room.logged = true;
    const [host, guest] = room.players;
    try {
      this.onRound({
        room: room.id,
        round: room.round,
        host: host?.id ?? null,
        guest: guest?.id ?? null,
        hostScore: host?.score ?? null,
        guestScore: guest?.score ?? null,
        hostTSpins: host?.tSpins ?? null,
        hostTSpinPoints: host?.tSpinPoints ?? null,
        guestTSpins: guest?.tSpins ?? null,
        guestTSpinPoints: guest?.tSpinPoints ?? null,
        winner: ended !== 'finished' || !room.loser ? null : room.loser === host ? 'guest' : 'host',
        ended,
        durationMs: Math.max(0, this.now() - room.startedAt),
      });
    } catch (e) {
      console.error('[match] could not log a round', e);
    }
  }

  /**
   * A player is gone: the room closes, and the other player is told and let go. A round still being
   * played is logged as left by them.
   */
  private leave(room: Room, gone: Player) {
    if (this.rooms.get(room.code) !== room) return;
    this.log(room, this.closing ? 'restart' : room.players[0] === gone ? 'host-left' : 'guest-left');
    this.rooms.delete(room.code);
    if (room.waitTimer) clearTimeout(room.waitTimer);
    for (const p of room.players) {
      if (p === gone || !p.conn.open) continue;
      p.conn.send(JSON.stringify({ t: 'left' }));
      p.conn.close(CLOSE.normal);
    }
  }
}
