// Talks to the leaderboard server (server/). URLs are relative, so the game works from any path.

/** The only game with a leaderboard. The server keeps a mode column so others can come back later. */
const MODE = 'cut';

export const NAME_MAX = 10;

/**
 * Where scores go when the player leaves the name blank or skips. It's an ordinary shared name on
 * the server, so its board row is simply the best score anyone has played anonymously.
 */
export const ANON = 'INCOGNITO';

export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  lines: number;
  level: number;
  pieces: number;
  at: string;
}

export interface Boards {
  mode: typeof MODE;
  /** Monday 00:00 UTC of the current week */
  weekStart: string;
  week: BoardEntry[];
  allTime: BoardEntry[];
}

export interface Submitted extends Boards {
  name: string;
  weekRank: number | null;
  allTimeRank: number | null;
}

export interface GameStats {
  score: number;
  lines: number;
  level: number;
  pieces: number;
  durationMs: number;
  /** T-spins and the points they paid (part of score) */
  tSpins: number;
  tSpinPoints: number;
}

/** A finished game for the server's game log, sent whether or not the score is submitted. */
export interface GameRecord extends GameStats {
  cuts: number;
  bestCut: number;
  /** This browser's random id (storage.playerId), so one player's games can be told apart */
  player: string;
  /** From startSession when the game began */
  session: string;
}

/** A score is a name for a logged game: the server takes the numbers from the game it logged. */
export interface ScoreSubmission {
  name: string;
  /** The session the game was logged with (recordGame) */
  session: string;
}

const NAME_CHARS = /^[\p{L}\p{N} .\-_!?']+$/u;

/** Same rules as the server: arcade-style upper case, letters/digits/space and . - _ ! ? ' */
export function normalizeName(raw: string): string | null {
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!name || [...name].length > NAME_MAX || !NAME_CHARS.test(name)) return null;
  return name;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchBoards(): Promise<Boards> {
  return call<Boards>(`api/leaderboard?mode=${MODE}`);
}

/** Called as a game starts: the server logs (and so scores) only games with a session. */
export async function startSession(player: string): Promise<string> {
  const r = await call<{ session: string }>('api/games/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player }),
  });
  return r.session;
}

export function recordGame(g: GameRecord): Promise<{ id: number }> {
  return call<{ id: number }>('api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: MODE, ...g }),
  });
}

export function submitScore(s: ScoreSubmission): Promise<Submitted> {
  return call<Submitted>('api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: MODE, ...s }),
  });
}
