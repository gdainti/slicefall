import { ROTATIONS, type Rotation } from './field';
import { PIECE_ORDERS, type PieceOrder } from './pieces';

export type GameMode = 'cut' | 'versus' | 'online';
const GAME_MODES: GameMode[] = ['cut', 'versus', 'online'];
export type ThemeName = 'modern' | 'retro';

export interface Settings {
  sfx: number; // 0..1
  music: number; // 0..1
  track: number; // index into TRACKS, or -1 for off
  mode: GameMode;
  muted: boolean;
  /** Look of the game: the default, or the monochrome LCD one */
  theme: ThemeName;
  /** Last name entered for the leaderboard, offered again next time */
  name: string;
  /** On-screen controls on touch screens: joystick and spin slider, or buttons */
  touchControls: TouchControls;
  /** Which side of the screen the move control goes on; rotation takes the other */
  moveSide: MoveSide;
  /** Versus and Online: cutting rows sends the other player blocks (online, the host's setting counts) */
  attacks: boolean;
  /** How the next piece is chosen, 7-bag or fully random (online, the host's setting counts) */
  pieces: PieceOrder;
  /** Free (turn to any angle) or 90° (quarter turns); each player's own, also online */
  rotation: Rotation;
  /** Hold: put the falling piece away for later (online, the host's setting counts) */
  hold: boolean;
}

export type TouchControls = 'drag' | 'buttons';
export type MoveSide = 'left' | 'right';
export const TOUCH_CONTROLS: TouchControls[] = ['drag', 'buttons'];
export const MOVE_SIDES: MoveSide[] = ['left', 'right'];

export interface ScoreEntry {
  name: string;
  score: number;
}

const SETTINGS_KEY = 'slicefall.settings.v1';
const SCORES_KEY = 'slicefall.scores.v1';
const PLAYER_KEY = 'slicefall.player.v1';
export const TABLE_SIZE = 5;

const DEFAULT_SETTINGS: Settings = {
  sfx: 0.8,
  music: 0.6,
  track: 0,
  mode: 'cut',
  muted: false,
  theme: 'modern',
  name: '',
  touchControls: 'drag',
  moveSide: 'left',
  attacks: true,
  pieces: 'bag',
  rotation: 'free',
  hold: false,
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode etc.) - settings just won't persist */
  }
}

export function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(read<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
  // A mode that no longer exists (Stack) falls back to the default, and so does Online (see saveSettings)
  if (!GAME_MODES.includes(s.mode) || s.mode === 'online') s.mode = DEFAULT_SETTINGS.mode;
  if (!TOUCH_CONTROLS.includes(s.touchControls)) s.touchControls = DEFAULT_SETTINGS.touchControls;
  if (!MOVE_SIDES.includes(s.moveSide)) s.moveSide = DEFAULT_SETTINGS.moveSide;
  if (typeof s.attacks !== 'boolean') s.attacks = DEFAULT_SETTINGS.attacks;
  if (!PIECE_ORDERS.includes(s.pieces)) s.pieces = DEFAULT_SETTINGS.pieces;
  if (!ROTATIONS.includes(s.rotation)) s.rotation = DEFAULT_SETTINGS.rotation;
  if (typeof s.hold !== 'boolean') s.hold = DEFAULT_SETTINGS.hold;
  return s;
}

/** Online is never remembered: it goes in as Cut, so Online is always picked on purpose. */
export function saveSettings(s: Settings) {
  write(SETTINGS_KEY, s.mode === 'online' ? { ...s, mode: DEFAULT_SETTINGS.mode } : s);
}

let player: string | null = null;

/**
 * A random id for this browser, made on first use and kept in localStorage, so the server's game
 * log can tell one player's games apart. It says nothing about who they are. Without storage it
 * lasts until the page is closed.
 */
export function playerId(): string {
  if (player) return player;
  const kept = read<string>(PLAYER_KEY);
  if (typeof kept === 'string' && /^[0-9a-f]{32}$/.test(kept)) return (player = kept);
  // getRandomValues, not randomUUID: the latter needs a secure context, and LAN play over http has none.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  player = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  write(PLAYER_KEY, player);
  return player;
}

/** Stored as { cut: [...] }; older saves may also carry a Stack table, which is dropped on the next write. */
function loadTable(): ScoreEntry[] {
  return read<{ cut?: ScoreEntry[] }>(SCORES_KEY)?.cut ?? [];
}

export function highScores(): ScoreEntry[] {
  return loadTable().slice(0, TABLE_SIZE);
}

export function qualifies(score: number): boolean {
  if (score <= 0) return false;
  const t = highScores();
  return t.length < TABLE_SIZE || score > t[t.length - 1].score;
}

export function addHighScore(entry: ScoreEntry): number {
  const t = loadTable();
  t.push(entry);
  t.sort((a, b) => b.score - a.score);
  const cut = t.slice(0, TABLE_SIZE);
  write(SCORES_KEY, { cut });
  return cut.indexOf(entry);
}
