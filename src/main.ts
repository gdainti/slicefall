import './style.css';
import { audio, TRACKS } from './audio';
import { STEP } from './config';
import { Demo } from './demo';
import { logoHtml } from './logo';
import { H, OnlineGame, SINGLE_W, SingleGame, VersusGame } from './games';
import { clearTouch, pollPadPresses, setTouch, setTouchMove, setTouchSpin, suppressHeldKeys } from './input';
import { COLORS, drawBackground, drawField, setTheme } from './render';
import { ANON, type Boards, fetchBoards, NAME_MAX, normalizeName, recordGame, startSession, submitScore, type Submitted } from './api';
import { CODE_LENGTH, type MatchError, MatchSocket, normalizeCode } from './net';
import { report, reportSetting, type LeaveVia } from './events';
import {
  type GameMode,
  type ThemeName,
  addHighScore,
  highScores,
  loadSettings,
  MOVE_SIDES,
  playerId,
  qualifies,
  saveSettings,
  TABLE_SIZE,
  TOUCH_CONTROLS,
} from './storage';
import { Menu, esc, type ChoiceItem } from './ui';
import { ROTATIONS, type Rotation } from './field';
import { PIECE_ORDERS, type PieceOrder } from './pieces';

/** package.json's version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const stage = document.getElementById('stage')!;
const overlay = document.getElementById('overlay')!;
const touchEl = document.getElementById('touch')!;
const pauseBtn = document.getElementById('pausebtn') as HTMLButtonElement;
const toastEl = document.getElementById('toast')!;
document.getElementById('version')!.textContent = `v${__APP_VERSION__}`;

const settings = loadSettings();
audio.setVolumes(settings.sfx, settings.music);
audio.setMuted(settings.muted);
const menu = new Menu(overlay, (s) => audio.play(s));

type AppState = 'title' | 'menu' | 'game' | 'paused' | 'gameover' | 'results';
let state: AppState = 'title';
let game: SingleGame | VersusGame | OnlineGame | null = null;
let demo = new Demo();
let logicalW = SINGLE_W;
let scale = 1;
let cssScale = 1;

const MODES: GameMode[] = ['cut', 'versus', 'online'];
const MODE_NAMES: Record<GameMode, string> = { cut: 'Cut', versus: 'Versus', online: 'Online' };
const THEMES: ThemeName[] = ['modern', 'retro'];
const THEME_NAMES: Record<ThemeName, string> = { modern: 'Modern', retro: 'Retro' };
const ROTATION_NAMES: Record<Rotation, string> = { free: 'Free', quarter: '90°' };
const PIECE_ORDER_NAMES: Record<PieceOrder, string> = { bag: '7-bag', random: 'Random' };
const isCoarse = window.matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------------ look

/** Applies settings.theme to the canvas drawing and, through data-theme, to the HTML menus. */
function applyTheme() {
  if (!THEMES.includes(settings.theme)) settings.theme = 'modern';
  setTheme(settings.theme);
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS.bg);
}

// ------------------------------------------------------------------ layout

function fit() {
  const touchH = touchEl.hidden ? 0 : touchEl.getBoundingClientRect().height;
  const availW = window.innerWidth;
  const availH = window.innerHeight - touchH;
  const s = Math.max(0.2, Math.min(availW / logicalW, availH / H));
  const cssW = Math.floor(logicalW * s);
  const cssH = Math.floor(H * s);
  const dpr = window.devicePixelRatio || 1;
  stage.style.width = `${cssW}px`;
  stage.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  scale = canvas.width / logicalW;
  cssScale = s;
  stage.style.setProperty('--s', String(Math.max(0.55, s)));
  updateHud();
}

const PAUSE_HTML = pauseBtn.innerHTML;
const LEAVE_HTML = 'Leave <span class="kbd">Esc</span>';

/** Shows the HTML pause button over the game's HUD slot while a game is running (Leave, online). */
function updateHud() {
  const rect = state === 'game' && game ? game.pauseRect : null;
  pauseBtn.hidden = !rect;
  if (!rect) return;
  const online = game?.type === 'online';
  const html = online ? LEAVE_HTML : PAUSE_HTML;
  if (pauseBtn.innerHTML !== html) pauseBtn.innerHTML = html;
  pauseBtn.setAttribute('aria-label', online ? 'Leave' : 'Pause');
  pauseBtn.style.left = `${rect.x * cssScale}px`;
  pauseBtn.style.top = `${rect.y * cssScale}px`;
  pauseBtn.style.width = `${rect.w * cssScale}px`;
  pauseBtn.style.height = `${rect.h * cssScale}px`;
  pauseBtn.style.fontSize = `${14 * cssScale}px`;
}

let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1100);
}

function toggleMute() {
  const was = settings.muted;
  settings.muted = !settings.muted;
  audio.setMuted(settings.muted);
  saveSettings(settings);
  reportMute(was);
  toast(settings.muted ? 'Sound off' : 'Sound on');
  menu.refresh();
}

/** Reports muting or unmuting (the M key or Options → Audio) to the events chat, once it has settled. */
function reportMute(was: boolean) {
  reportSetting('sound', String(was), String(settings.muted), { type: 'sound', muted: settings.muted });
}

const percent = (v: number) => Math.round(v * 100);
const volumes = () => `${percent(settings.sfx)}/${percent(settings.music)}`;

/** Reports the Sound and Music volumes once the sliders have stopped moving. */
function reportVolume(was: string) {
  reportSetting('volume', was, volumes(), { type: 'volume', sfx: percent(settings.sfx), music: percent(settings.music) });
}

function setLayout(w: number) {
  if (w !== logicalW) {
    logicalW = w;
    fit();
  }
}

/** Applies the touch control settings: which controls to show, and the move control's side. */
function applyTouchLayout() {
  touchEl.dataset.controls = settings.touchControls;
  touchEl.dataset.side = settings.moveSide;
  clearTouch();
  // The two kinds of controls differ in height, and the field is sized to the room above them.
  if (!touchEl.hidden) fit();
}
applyTouchLayout();

function updateTouch() {
  // Still shown while paused, so the board keeps its size and Options changes show at once.
  const show = isCoarse && (state === 'game' || state === 'paused') && (game?.type === 'single' || game?.type === 'online');
  const live = show && state === 'game';
  if (touchEl.hidden === show) {
    touchEl.hidden = !show;
    fit();
  }
  touchEl.classList.toggle('paused', !live);
  if (!live) {
    // Let go of any control a thumb is still on, so none is stuck held after resuming.
    touchEl.querySelectorAll('button, #stick, #spin').forEach((el) => el.dispatchEvent(new Event('release')));
    clearTouch();
  }
  updateHud();
}

window.addEventListener('resize', fit);

// ------------------------------------------------------------------ music

/** Plays the chosen track. Moving between menus keeps it going; `restart` starts it over. */
function startMusic(restart = false) {
  if (settings.track >= 0) audio.playTrack(settings.track, restart);
  else audio.stopMusic();
}

// ------------------------------------------------------------------ screens

function showTitle() {
  leaveMatch();
  state = 'title';
  game = null;
  startMusic();
  setLayout(SINGLE_W);
  updateTouch();
  menu.show({
    className: 'title',
    title: 'Slicefall',
    titleClass: 'logo',
    titleHtml: logoHtml(),
    subtitle: 'Blocks with real physics. Rows get sliced out once they are packed full enough.',
    items: [
      { type: 'button', label: 'Play', action: showModeSelect },
      { type: 'button', label: 'Leaderboard', action: showLeaderboard },
      { type: 'button', label: 'Options', action: () => showOptions(showTitle) },
    ],
    footer:
      'Gameplay ported from <a href="https://github.com/Stabyourself/nottetris2" target="_blank" rel="noopener">Not Tetris 2</a> by Maurice Guégan, a physics take on Tetris, which Alexey Pajitnov created in 1984.<br>Press F for fullscreen.',
  });
}

function modeInfo(mode: GameMode): string {
  const text: Record<GameMode, string> = {
    cut: 'Endless. A row is sliced out when it holds 8.1 blocks’ worth of area, cutting right through the pieces. Tighter rows score more. Every 10 rows the pieces fall faster.',
    versus: 'Two players, one keyboard (or two gamepads). Same pieces, mirrored for player 1, and rows are cut as in Cut. Whoever tops out first loses, and the game ends for both.',
    online: 'Two players, each on their own device. Create a game and tell the other player its code, or join theirs with the code they give you. Same pieces for both; whoever tops out first loses, and the round ends for both. Pieces and Attacks: the setting of whoever creates the game counts; Rotation is each player’s own.',
  };
  let out = `<p class="info">${text[mode]}</p>`;
  out += `<p class="info">${
    settings.pieces === 'bag'
      ? 'Pieces: 7-bag. All seven come once each, shuffled, before any comes again, so never more than two of a kind in a row.'
      : 'Pieces: random. Any piece can come next, even the same one many times in a row.'
  }</p>`;
  if (settings.rotation === 'quarter') {
    out += `<p class="info">Rotation: 90°. Each press turns the falling piece a quarter turn, and it stays square until it lands. No T-spins.</p>`;
  }
  if (mode !== 'cut' && settings.attacks) {
    out += `<p class="info">Attacks: cutting rows sends the other player single blocks. They blink at the top of their column, then drop between pieces once a whole piece has landed. Cut rows of your own first to cancel them.</p>`;
  }
  if (mode === 'versus') {
    out += `<div class="keys"><div><b>Player 1</b>A D move · S down · Q E rotate</div><div><b>Player 2</b>J L move · K down · U O rotate<br><span>or ← → ↓ and , .</span></div></div>`;
  } else if (mode === 'cut') {
    out += scoreTable(-1);
  }
  return out;
}

function scoreTable(highlight: number): string {
  const rows = highScores();
  const lines: string[] = [];
  for (let i = 0; i < TABLE_SIZE; i++) {
    const r = rows[i];
    lines.push(
      `<tr class="${i === highlight ? 'me' : ''}"><td>${i + 1}</td><td>${r ? esc(r.name) : '—'}</td><td>${r ? r.score : ''}</td></tr>`,
    );
  }
  return `<table class="scores"><caption>Your best on this device</caption>${lines.join('')}</table>`;
}

// ------------------------------------------------------------------ online leaderboard

const BOARD_ROWS = 10;
type Period = 'week' | 'allTime';

/** What a leaderboard panel shows. Screens keep one and re-render as data arrives. */
interface BoardView {
  period: Period;
  data: Boards | null;
  status: 'loading' | 'ok' | 'offline';
  /** Name to highlight (the player's own) */
  me: string | null;
  /** Set after submitting a score: where the player now stands */
  ranks: { week: number | null; allTime: number | null } | null;
  /** Row of the local table to highlight when the server can't be reached */
  localRank: number;
}

function boardView(localRank = -1): BoardView {
  return { period: 'week', data: null, status: 'loading', me: normalizeName(settings.name), ranks: null, localRank };
}

/** `anon`: the score went in as ANON, so it isn't the player's own row and gets no "You:" line. */
function loadBoards(view: BoardView, request: Promise<Boards | Submitted>, anon = false) {
  const screen = menu.current;
  view.status = 'loading';
  request
    .then((data) => {
      view.data = data;
      view.status = 'ok';
      if ('weekRank' in data && !anon) {
        view.me = data.name;
        view.ranks = { week: data.weekRank, allTime: data.allTimeRank };
      }
    })
    .catch(() => {
      view.status = 'offline';
    })
    .finally(() => {
      if (menu.current === screen) menu.refresh();
    });
}

function boardHtml(view: BoardView): string {
  const title = view.period === 'week' ? 'This week' : 'All time';
  if (view.status === 'offline') {
    return `<p class="rankline warn">The online leaderboard can’t be reached right now.</p>${scoreTable(view.localRank)}`;
  }
  const entries = view.status === 'ok' && view.data ? view.data[view.period] : [];
  const rows: string[] = [];
  for (let i = 0; i < BOARD_ROWS; i++) {
    const e = entries[i];
    const me = e && e.name === view.me ? ' class="me"' : '';
    rows.push(
      e
        ? `<tr${me}><td>${e.rank}</td><td>${esc(e.name)}</td><td class="sub">${e.lines}</td><td>${e.score}</td></tr>`
        : `<tr><td>${i + 1}</td><td>—</td><td class="sub"></td><td></td></tr>`,
    );
  }
  const head = '<tr class="head"><th>#</th><th>Name</th><th class="sub">Lines</th><th>Score</th></tr>';

  let line = '&nbsp;';
  if (view.status === 'loading') line = 'Loading…';
  else if (view.ranks) {
    const r = view.ranks;
    line = `You: #${r.week ?? '–'} this week · #${r.allTime ?? '–'} all time`;
  } else if (!entries.length) line = view.period === 'week' ? 'No scores yet this week. Be the first!' : 'No scores yet. Be the first!';
  const st = view.status === 'ok' ? view.data?.stats?.[view.period] : undefined;
  const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const stats = st
    ? [count(st.started, 'game', 'games'), st.lines === undefined ? '' : count(st.lines, 'line', 'lines'), count(st.names, 'player', 'players')]
        .filter(Boolean)
        .join(' · ')
    : '&nbsp;';
  return (
    `<table class="scores board"><caption>${title}</caption>${head}${rows.join('')}</table>` +
    `<p class="rankline">${line}</p><p class="boardstats">${stats}</p>`
  );
}

function periodChoice(view: BoardView) {
  return {
    type: 'choice' as const,
    label: 'Board',
    options: ['This week', 'All time'],
    get: () => (view.period === 'week' ? 0 : 1),
    set: (i: number) => {
      view.period = i === 0 ? 'week' : 'allTime';
    },
  };
}

function showLeaderboard() {
  state = 'menu';
  const view = boardView();
  menu.show({
    title: 'Leaderboard',
    className: 'tight',
    items: [periodChoice(view)],
    html: () => boardHtml(view),
    footer: 'Best score per name · weeks start Monday 00:00 UTC',
    onBack: showTitle,
    backButton: true,
  });
  loadBoards(view, fetchBoards());
}

/**
 * Opens the Game type screen. Each visit starts on Cut rather than Online (the other settings stay
 * as they were), so the player always picks Online themselves.
 */
function showModeSelect() {
  if (settings.mode === 'online') settings.mode = 'cut';
  modeScreen();
}

/** Draws the Game type screen as it is (also when switching modes on it). `focus`: the row to select (by default Start). */
function modeScreen(focus?: number) {
  leaveMatch();
  state = 'menu';
  game = null;
  setLayout(SINGLE_W);
  updateTouch();
  startMusic();
  // Versus and Online also get an Attacks row; switching to or from Cut rebuilds the screen
  const versus = settings.mode !== 'cut';
  menu.show({
    title: 'Game type',
    // The subtitle takes the row Back used to have, so Start still lands under the mouse after clicking Play
    subtitle: 'Pick a mode and some music.',
    className: 'pinned',
    items: [
      {
        type: 'choice',
        label: 'Mode',
        options: MODES.map((m) => MODE_NAMES[m]),
        get: () => MODES.indexOf(settings.mode),
        set: (i) => {
          settings.mode = MODES[i];
          saveSettings(settings);
          if ((settings.mode !== 'cut') !== versus) modeScreen(0);
        },
      },
      ...(versus
        ? [
            {
              type: 'choice' as const,
              label: 'Attacks',
              options: ['On', 'Off'],
              get: () => (settings.attacks ? 0 : 1),
              set: (i: number) => {
                settings.attacks = i === 0;
                saveSettings(settings);
              },
            },
          ]
        : []),
      {
        type: 'choice',
        label: 'Pieces',
        options: PIECE_ORDERS.map((o) => PIECE_ORDER_NAMES[o]),
        get: () => PIECE_ORDERS.indexOf(settings.pieces),
        set: (i) => {
          settings.pieces = PIECE_ORDERS[i];
          saveSettings(settings);
        },
      },
      rotationChoice(),
      {
        type: 'choice',
        label: 'Music',
        options: [...TRACKS.map((t) => t.name), 'Off'],
        get: () => (settings.track < 0 ? TRACKS.length : settings.track),
        set: (i) => {
          settings.track = i >= TRACKS.length ? -1 : i;
          saveSettings(settings);
          startMusic();
        },
      },
      { type: 'button', label: 'Start', action: () => (settings.mode === 'online' ? showOnline() : startGame()), primary: true },
    ],
    initial: focus ?? (versus ? 5 : 4),
    html: () => modeInfo(settings.mode),
    onBack: showTitle,
    backButton: true,
  });
}

/**
 * Sets Free or 90° rotation, for the game being played too. On touch screens each brings its
 * own default layout, Buttons for 90° (a tap is a quarter turn) and the joystick and spin slider
 * for Free; Touch controls in Options can still change it afterwards.
 */
function setRotation(r: Rotation) {
  if (r === settings.rotation) return;
  settings.rotation = r;
  settings.touchControls = r === 'quarter' ? 'buttons' : 'drag';
  saveSettings(settings);
  applyTouchLayout();
  if (game) for (const f of game.type === 'versus' ? game.fields : [game.field]) f.rotation = r;
}

function rotationChoice(): ChoiceItem {
  return {
    type: 'choice',
    label: 'Rotation',
    options: ROTATIONS.map((r) => ROTATION_NAMES[r]),
    get: () => ROTATIONS.indexOf(settings.rotation),
    set: (i) => setRotation(ROTATIONS[i]),
  };
}

/** `inGame`: opened from the pause menu, so it also offers Rotation for the game going on. */
function showOptions(back: () => void, inGame = false) {
  menu.show({
    title: 'Options',
    items: [
      {
        type: 'choice',
        label: 'Audio',
        options: ['On', 'Muted'],
        get: () => (settings.muted ? 1 : 0),
        set: (i) => {
          const was = settings.muted;
          settings.muted = i === 1;
          audio.setMuted(settings.muted);
          saveSettings(settings);
          reportMute(was);
        },
      },
      {
        type: 'slider',
        label: 'Sound',
        get: () => settings.sfx,
        set: (v) => {
          const was = volumes();
          settings.sfx = v;
          audio.setVolumes(settings.sfx, settings.music);
          saveSettings(settings);
          reportVolume(was);
        },
      },
      {
        type: 'slider',
        label: 'Music',
        get: () => settings.music,
        set: (v) => {
          const was = volumes();
          settings.music = v;
          audio.setVolumes(settings.sfx, settings.music);
          saveSettings(settings);
          reportVolume(was);
        },
      },
      {
        type: 'choice',
        label: 'Graphics',
        options: THEMES.map((t) => THEME_NAMES[t]),
        get: () => THEMES.indexOf(settings.theme),
        set: (i) => {
          const was = settings.theme;
          settings.theme = THEMES[i];
          saveSettings(settings);
          applyTheme();
          reportSetting('theme', was, settings.theme, { type: 'theme', theme: settings.theme });
        },
      },
      ...(inGame ? [rotationChoice()] : []),
      // The on-screen controls only appear on touch screens, so only they get these settings.
      ...(isCoarse
        ? [
            {
              type: 'choice' as const,
              label: 'Touch controls',
              options: ['Joystick', 'Buttons'],
              get: () => TOUCH_CONTROLS.indexOf(settings.touchControls),
              set: (i: number) => {
                settings.touchControls = TOUCH_CONTROLS[i];
                saveSettings(settings);
                applyTouchLayout();
              },
            },
            {
              type: 'choice' as const,
              label: 'Move with',
              options: ['Left hand', 'Right hand'],
              get: () => MOVE_SIDES.indexOf(settings.moveSide),
              set: (i: number) => {
                settings.moveSide = MOVE_SIDES[i];
                saveSettings(settings);
                applyTouchLayout();
              },
            },
          ]
        : []),
      { type: 'button', label: 'Toggle fullscreen', keyLabel: 'F', action: toggleFullscreen },
    ],
    footer: 'M mutes sound at any time.',
    onBack: back,
    backButton: true,
  });
}

/**
 * The server's session for the Cut game being played, asked for as it starts (without waiting for
 * it). Undefined when the server couldn't be reached: the game plays on but can't be scored.
 */
let session: Promise<string | undefined> = Promise.resolve(undefined);

function startGame() {
  menu.hide();
  audio.unlock();
  suppressHeldKeys();
  if (settings.mode === 'versus') {
    audio.stopMusic();
    game = new VersusGame(startMusic, showVersusResults, settings.attacks, settings.pieces, settings.rotation);
    report({ type: 'start', mode: 'versus' });
  } else {
    session = startSession(playerId()).catch(() => undefined);
    game = new SingleGame(onSingleOver, settings.pieces, settings.rotation);
    game.start();
    startMusic(true);
    report({ type: 'start', mode: 'cut' });
  }
  setLayout(game.width);
  state = 'game';
  updateTouch();
}

function pause() {
  if (state !== 'game' || !game) return;
  if (game.type !== 'single' && game.phase === 'done') return;
  if (game.type === 'online') return confirmLeave();
  game.paused = true;
  state = 'paused';
  audio.pauseMusic();
  audio.play('pause');
  updateTouch();
  menu.show({
    title: 'Paused',
    className: 'compact',
    items: [
      { type: 'button', label: 'Resume', keys: ['KeyP'], keyLabel: 'P', action: resume },
      {
        type: 'button',
        label: 'Restart',
        keys: ['KeyR'],
        keyLabel: 'R',
        action: () => {
          reportLeave('restart');
          startGame();
        },
      },
      { type: 'button', label: 'Options', keys: ['KeyO'], keyLabel: 'O', action: () => showOptions(pauseMenuAgain, true) },
      {
        type: 'button',
        label: 'Quit to menu',
        keys: ['KeyQ'],
        keyLabel: 'Q',
        action: () => {
          reportLeave('menu');
          showModeSelect();
        },
      },
    ],
    footer: 'Esc also resumes · M mute · F fullscreen',
    onBack: resume,
  });
}

/**
 * Online there is no pause: both games run at the same time. Esc, P or the Leave button only ask
 * whether to leave, and the game goes on underneath (without this player's controls) meanwhile.
 */
function confirmLeave() {
  state = 'paused';
  updateTouch();
  menu.show({
    title: 'Leave the game?',
    subtitle: 'Your game keeps running while this is open.',
    className: 'compact',
    items: [
      { type: 'button', label: 'Keep playing', keyLabel: 'Esc', action: keepPlaying },
      {
        type: 'button',
        label: 'Leave game',
        keys: ['KeyQ'],
        keyLabel: 'Q',
        action: () => {
          reportLeave('menu');
          showOnline();
        },
      },
    ],
    onBack: keepPlaying,
  });
}

function keepPlaying() {
  if (state !== 'paused') return;
  menu.hide();
  state = 'game';
  suppressHeldKeys();
  updateTouch();
}

function pauseMenuAgain() {
  state = 'game';
  pause();
}

function resume() {
  if (!game) return;
  menu.hide();
  game.paused = false;
  state = 'game';
  suppressHeldKeys();
  audio.resumeMusic();
  updateTouch();
}

/**
 * Reports leaving a game that is still going, with how far it got. A game over or a results screen
 * has been reported already, and the menus clear `game`, so neither reports again.
 */
function reportLeave(via: LeaveVia) {
  const g = game;
  if (!g || state === 'gameover' || state === 'results') return;
  if (g.type === 'single') {
    const f = g.field;
    report({ type: 'leave', via, mode: 'cut', score: f.score, lines: f.lines, level: f.level, durationMs: Math.round(g.elapsed * 1000) });
  } else if (g.type === 'versus') {
    report({ type: 'leave', via, mode: 'versus', scores: [g.fields[0].score, g.fields[1].score] });
  } else if (match) {
    report({ type: 'leave', via, mode: 'online', host: match.host, round: match.round, you: g.field.score });
  }
}

/** Game over in Cut: log the game, ask for a name, then show where the score landed. */
function onSingleOver() {
  const g = game as SingleGame;
  state = 'gameover';
  updateTouch();
  const f = g.field;
  const stats = {
    score: f.score,
    lines: f.lines,
    level: f.level,
    pieces: f.placed,
    durationMs: Math.round(g.elapsed * 1000),
    tSpins: f.tSpins,
    tSpinPoints: f.tSpinPoints,
  };
  report({ type: 'finish', mode: 'cut', score: stats.score, lines: stats.lines, level: stats.level, durationMs: stats.durationMs });
  // Every finished game goes in the server's game log, even when the score is skipped. The score
  // then only names the logged game, so it needs the log to have worked.
  const logged = session.then(async (s) => {
    if (!s) throw new Error('No connection to the leaderboard');
    await recordGame({ ...stats, cuts: f.cuts, bestCut: f.bestCut, player: playerId(), session: s });
    return s;
  });
  logged.catch(() => {}); // a skipped score doesn't wait for it
  if (f.score <= 0) {
    showGameOver(g, fetchBoards(), -1);
    return;
  }
  const personalBest = qualifies(f.score);
  if (personalBest) audio.play('highscore');

  /** Sends the score under `name`, or under the shared ANON name when there is none. */
  const send = (name: string | null) => {
    // Anonymous play leaves no trace of a name: the remembered one stays as it was.
    if (name) {
      settings.name = name;
      saveSettings(settings);
    }
    const localRank = personalBest ? addHighScore({ name: name ?? ANON, score: f.score }) : -1;
    // Waits for the game to be logged (usually done long before the name is typed).
    const request = logged.then((s) => submitScore({ name: name ?? ANON, session: s }));
    showGameOver(g, request, localRank, !name);
  };
  const submit = () => {
    const input = overlay.querySelector<HTMLInputElement>('input.name');
    const raw = input?.value ?? '';
    if (!raw.trim()) return send(null);
    const name = normalizeName(raw);
    if (!name) {
      overlay.querySelector('.namefield')?.classList.add('bad');
      audio.play('back');
      input?.focus();
      return;
    }
    send(name);
  };
  const skip = () => send(null);

  menu.show({
    title: personalBest ? 'New high score!' : 'Game Over',
    className: 'compact',
    htmlFirst: true,
    html: () =>
      `<p class="big">${f.score}</p>` +
      `<label class="namefield">Name for the leaderboard<input class="name" maxlength="${NAME_MAX}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="YOUR NAME" value="${esc(settings.name)}"></label>` +
      `<p class="hint">Up to ${NAME_MAX} letters, digits, spaces or . - _ ! ? '<br>Leave it blank or skip to play as ${ANON}</p>`,
    items: [
      { type: 'button', label: 'Submit score', keyLabel: '↵', action: submit },
      { type: 'button', label: 'Skip', keyLabel: 'Esc', action: skip },
    ],
    onBack: skip,
    afterRender: (root) => {
      const input = root.querySelector<HTMLInputElement>('input.name');
      if (!input) return;
      input.focus();
      input.select();
      input.addEventListener('input', () => root.querySelector('.namefield')?.classList.remove('bad'));
      // Enter in the field always submits, wherever the mouse happens to rest.
      input.addEventListener('keydown', (e) => {
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
        e.preventDefault();
        e.stopPropagation();
        audio.play('select');
        submit();
      });
    },
  });
}

function showGameOver(g: SingleGame, request: Promise<Boards | Submitted>, localRank: number, anon = false) {
  const f = g.field;
  const stats = `<div class="stats"><div><span>Score</span><b>${f.score}</b></div><div><span>Level</span><b>${f.level}</b></div><div><span>Lines</span><b>${f.lines}</b></div></div>`;
  const view = boardView(localRank);
  if (anon) view.me = null;
  menu.show({
    title: 'Game Over',
    className: 'results tight',
    htmlFirst: true,
    html: () => stats + boardHtml(view),
    items: [
      periodChoice(view),
      { type: 'button', label: 'Play again', action: startGame },
    ],
    initial: 1,
    onBack: showModeSelect,
    backButton: true,
  });
  loadBoards(view, request, anon);
}

function showVersusResults() {
  const g = game as VersusGame;
  state = 'results';
  updateTouch();
  const [a, b] = g.fields.map((f) => f.score);
  report({ type: 'finish', mode: 'versus', scores: [a, b], winner: g.winner === 2 ? 0 : g.winner === 0 ? 1 : 2 });
  menu.show({
    title: g.winner === 2 ? 'Draw!' : `Player ${g.winner + 1} wins!`,
    className: 'compact',
    htmlFirst: true,
    html: () =>
      `<div class="stats"><div><span>Player 1</span><b>${a}</b></div><div><span>Player 2</span><b>${b}</b></div></div><p class="info center">Wins ${VersusGame.wins[0]} – ${VersusGame.wins[1]}</p>`,
    items: [
      { type: 'button', label: 'Rematch', action: startGame },
      { type: 'button', label: 'Change mode', action: showModeSelect },
    ],
    onBack: showModeSelect,
  });
}

// ------------------------------------------------------------------ online versus

interface Match {
  socket: MatchSocket;
  /** This player created the room (or joined someone else's) */
  host: boolean;
  /** The round being played, from 1 */
  round: number;
  /** Rounds won in this room: [this player, the other] */
  wins: [number, number];
  /** This player, or the other, asked for a rematch after the last round */
  rematch: boolean;
  theyRematch: boolean;
  /** Why the room ended after a round was decided (the other player left, or the connection dropped) */
  gone: string | null;
}

let match: Match | null = null;

function leaveMatch() {
  match?.socket.close();
  match = null;
}

function matchError(e: MatchError): string {
  switch (e) {
    case 'not-found':
      return 'There is no game with that code. Check it, or ask for a new one.';
    case 'full':
      return 'That game already has two players.';
    case 'busy':
      return 'The server is full right now. Try again in a minute.';
    case 'limit':
      return 'Too many tries from here. Wait a few minutes.';
    case 'offline':
      return 'The game server can’t be reached right now.';
    case 'lost':
      return 'The connection to the game server was lost.';
  }
}

function showOnline(note = '') {
  leaveMatch();
  state = 'menu';
  game = null;
  setLayout(SINGLE_W);
  updateTouch();
  startMusic();
  menu.show({
    title: 'Online',
    subtitle: 'Play against someone on another device.',
    items: [
      { type: 'button', label: 'Create a game', action: createMatch, primary: true },
      { type: 'button', label: 'Join with a code', action: () => showJoin('') },
    ],
    html: () =>
      (note ? `<p class="rankline warn">${esc(note)}</p>` : '') +
      '<p class="info">Create a game and tell the other player its code, or type in the code they give you. You both get the same pieces. Whoever tops out first loses.</p>',
    onBack: showModeSelect,
    backButton: true,
  });
}

/** A screen to look at while the server answers. */
function showConnecting(title: string, back: () => void) {
  menu.show({
    title,
    className: 'compact',
    html: () => '<p class="info center">Connecting…</p>',
    items: [{ type: 'button', label: 'Cancel', action: back }],
    onBack: back,
  });
}

function createMatch() {
  leaveMatch();
  const socket = new MatchSocket({ t: 'create', player: playerId(), attacks: settings.attacks, pieces: settings.pieces });
  match = { socket, host: true, round: 0, wins: [0, 0], rematch: false, theyRematch: false, gone: null };
  socket.on = {
    room: showWaiting,
    start: startOnline,
    error: (e) => showOnline(matchError(e)),
  };
  showConnecting('Create a game', () => showOnline());
}

function showWaiting(code: string) {
  menu.show({
    title: 'Invite a player',
    className: 'compact',
    htmlFirst: true,
    html: () =>
      `<p class="info center">Give the other player this code</p><p class="big code">${esc(code)}</p>` +
      '<p class="info center">They pick Online → Join with a code. The game starts as soon as they join.</p>',
    items: [{ type: 'button', label: 'Cancel', keyLabel: 'Esc', action: () => showOnline() }],
    onBack: () => showOnline(),
  });
}

function showJoin(code: string, note = '') {
  leaveMatch();
  state = 'menu';
  game = null;
  setLayout(SINGLE_W);
  updateTouch();
  const submit = () => {
    const input = overlay.querySelector<HTMLInputElement>('input.code');
    const typed = normalizeCode(input?.value ?? '');
    if (!typed) {
      overlay.querySelector('.namefield')?.classList.add('bad');
      audio.play('back');
      input?.focus();
      return;
    }
    joinMatch(typed);
  };
  menu.show({
    title: 'Join a game',
    className: 'compact',
    htmlFirst: true,
    html: () =>
      (note ? `<p class="rankline warn">${esc(note)}</p>` : '') +
      `<label class="namefield">Code<input class="code" maxlength="${CODE_LENGTH + 1}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" value="${esc(code)}"></label>` +
      `<p class="hint">${CODE_LENGTH} letters and digits, from the player who created the game</p>`,
    items: [
      { type: 'button', label: 'Join', keyLabel: '↵', action: submit, primary: true },
      { type: 'button', label: 'Back', keyLabel: 'Esc', action: () => showOnline() },
    ],
    onBack: () => showOnline(),
    afterRender: (root) => {
      const input = root.querySelector<HTMLInputElement>('input.code');
      if (!input) return;
      input.focus();
      input.select();
      input.addEventListener('input', () => root.querySelector('.namefield')?.classList.remove('bad'));
      input.addEventListener('keydown', (e) => {
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
        e.preventDefault();
        e.stopPropagation();
        audio.play('select');
        submit();
      });
    },
  });
}

function joinMatch(code: string) {
  leaveMatch();
  const socket = new MatchSocket({ t: 'join', code, player: playerId() });
  match = { socket, host: false, round: 0, wins: [0, 0], rematch: false, theyRematch: false, gone: null };
  socket.on = {
    start: startOnline,
    error: (e) => showJoin(code, matchError(e)),
  };
  showConnecting(`Joining ${code}`, () => showJoin(code));
}

/** Starts a round in the current room (the first one, or a rematch), with the room's attack and piece settings. */
function startOnline(seed: number, round: number, attacks: boolean, pieces: PieceOrder) {
  const m = match;
  if (!m) return;
  m.round = round;
  report({ type: 'start', mode: 'online', host: m.host, round });
  m.rematch = false;
  m.theyRematch = false;
  menu.hide();
  audio.unlock();
  audio.stopMusic();
  suppressHeldKeys();
  const g = new OnlineGame(seed, m.wins, (msg) => m.socket.send(msg), startMusic, showOnlineResults, attacks, pieces, settings.rotation);
  game = g;
  m.socket.on = {
    state: (s) => g.receive(s),
    attack: (blocks) => g.receiveAttack(blocks),
    won: () => g.won(),
    result: (you, them, win) => g.finish(you, them, win),
    rematch: () => {
      m.theyRematch = true;
      if (state === 'results') menu.refresh();
    },
    start: startOnline,
    left: () => matchGone('The other player left.'),
    error: (e) => matchGone(matchError(e)),
  };
  setLayout(g.width);
  state = 'game';
  updateTouch();
}

/**
 * The room is gone. Before the round is decided that ends the game; after it, the result stays on
 * show and only the rematch goes.
 */
function matchGone(text: string) {
  const m = match;
  if (m && game instanceof OnlineGame && game.result) {
    m.gone = text;
    if (state === 'results') showOnlineResults(false);
    return;
  }
  showMatchOver(text);
}

function showOnlineResults(first = true) {
  const g = game as OnlineGame;
  const m = match;
  if (!m || !g.result) return;
  state = 'results';
  updateTouch();
  const { you, them, win } = g.result;
  if (first && win) audio.play('highscore');
  if (first) report({ type: 'finish', mode: 'online', host: m.host, round: m.round, you, them, ...(win === null ? {} : { win }) });
  const status = () => {
    if (m.gone) return esc(m.gone);
    if (m.rematch) return 'Waiting for the other player…';
    if (m.theyRematch) return 'The other player wants a rematch!';
    return '&nbsp;';
  };
  menu.show({
    title: win ? 'You win!' : win === false ? 'You lose' : 'Draw!',
    className: 'compact',
    htmlFirst: true,
    html: () =>
      `<div class="stats"><div><span>You</span><b>${you}</b></div><div><span>Opponent</span><b>${them}</b></div></div>` +
      `<p class="info center">Wins ${m.wins[0]} – ${m.wins[1]}</p><p class="rankline">${status()}</p>`,
    items: m.gone
      ? [
          { type: 'button', label: 'Play online again', action: () => showOnline(), primary: true },
          { type: 'button', label: 'Change mode', action: showModeSelect },
        ]
      : [
          {
            type: 'button',
            label: 'Rematch',
            primary: true,
            action: () => {
              if (m.rematch) return;
              m.rematch = true;
              m.socket.send({ t: 'rematch' });
              menu.refresh();
            },
          },
          { type: 'button', label: 'Leave', action: () => showOnline() },
        ],
    onBack: () => showOnline(),
  });
}

/** The room is gone (the other player left, or the connection dropped). */
function showMatchOver(text: string) {
  const wins = match?.wins ?? [0, 0];
  leaveMatch();
  if (game) game.paused = true;
  audio.stopMusic();
  state = 'results';
  updateTouch();
  menu.show({
    title: 'Game Over',
    className: 'compact',
    htmlFirst: true,
    html: () => `<p class="info center">${esc(text)}</p><p class="info center">Wins ${wins[0]} – ${wins[1]}</p>`,
    items: [
      { type: 'button', label: 'Play online again', action: () => showOnline(), primary: true },
      { type: 'button', label: 'Change mode', action: showModeSelect },
    ],
    onBack: showModeSelect,
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

// ------------------------------------------------------------------ input routing

const PAUSE_KEYS = new Set(['Enter', 'NumpadEnter', 'Escape', 'KeyP']);
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'Backspace']);

function handleKey(code: string) {
  if (menu.active && menu.key(code)) return;
  if (state === 'game' && PAUSE_KEYS.has(code)) pause();
}

window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (e.target instanceof HTMLInputElement) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape') {
      e.preventDefault();
      handleKey(e.code);
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (SCROLL_KEYS.has(e.code)) e.preventDefault();
  // The menu handles Enter itself; stop a focused (mouse-clicked) button from also "clicking" natively.
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && menu.active) e.preventDefault();
  if (e.code === 'KeyF' && !e.repeat) {
    toggleFullscreen();
    return;
  }
  if (e.code === 'KeyM' && !e.repeat) {
    toggleMute();
    return;
  }
  const nav = e.code.startsWith('Arrow') && menu.active;
  if (e.repeat && !nav) return;
  handleKey(e.code);
});

window.addEventListener('pointerdown', () => audio.unlock());
// Online games don't pause: they keep going in the background (see advance())
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game?.type !== 'online') pause();
});
window.addEventListener('blur', () => {
  if (game?.type !== 'online') pause();
});

// Closing the page (or navigating away) with a game still going
window.addEventListener('pagehide', () => reportLeave('page'));

// Keep the button from taking keyboard focus, so Space/Enter never "click" it again later.
pauseBtn.addEventListener('pointerdown', (e) => e.preventDefault());
pauseBtn.addEventListener('click', () => pause());

touchEl.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((btn) => {
  const action = btn.dataset.a as 'left' | 'right' | 'down' | 'rotL' | 'rotR';
  const on = (e: PointerEvent) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('down');
    setTouch(action, true);
  };
  const off = () => {
    btn.classList.remove('down');
    setTouch(action, false);
  };
  btn.addEventListener('release', off);
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('lostpointercapture', off);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

/** Analog stick response: 0 inside the dead zone, then rising linearly to ±1 at full travel. */
function ramp(t: number, dead: number) {
  const a = Math.min(1, Math.abs(t));
  return a < dead ? 0 : (Math.sign(t) * (a - dead)) / (1 - dead);
}

// Joystick: the drag is measured from where the thumb first lands, so it works without aiming
// at the centre. It is analog: the further the drag, the harder the push. Sideways moves, downward
// drops faster, and a diagonal drag does both.
{
  const stick = document.getElementById('stick')!;
  const knob = stick.querySelector<HTMLElement>('.knob')!;
  let pointer: number | null = null;
  let ox = 0;
  let oy = 0;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const max = stick.clientWidth / 2 - knob.offsetWidth / 4;
    let dx = e.clientX - ox;
    let dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx *= max / len;
      dy *= max / len;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Down has the bigger dead zone, so a sideways drag that sags a little does not also drop.
    setTouchMove({ x: ramp(dx / max, 0.15), y: ramp(Math.max(0, dy) / max, 0.3) });
  };
  const end = (e: PointerEvent | Event) => {
    if (pointer === null || (e instanceof PointerEvent && e.pointerId !== pointer)) return;
    if (stick.hasPointerCapture(pointer)) stick.releasePointerCapture(pointer);
    pointer = null;
    stick.classList.remove('active');
    knob.style.transform = '';
    setTouchMove(null);
  };
  stick.addEventListener('release', end);
  stick.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stick.classList.add('active');
    ox = e.clientX;
    oy = e.clientY;
    setTouchMove({ x: 0, y: 0 });
  });
  stick.addEventListener('pointermove', move);
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
  stick.addEventListener('lostpointercapture', end);
  stick.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Spin slider: like the joystick, measured from where the thumb lands, but only sideways and
// analog: the further the slide, the faster the piece spins, up to full speed at the end of the
// knob's travel. Holding near the start point brakes the spin.
{
  const track = document.getElementById('spin')!;
  const knob = track.querySelector<HTMLElement>('.knob')!;
  let pointer: number | null = null;
  let ox = 0;
  track.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    track.setPointerCapture(e.pointerId);
    track.classList.add('active');
    ox = e.clientX;
    setTouchSpin(0);
  });
  track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const max = (track.clientWidth - knob.offsetWidth) / 2;
    const dx = Math.max(-max, Math.min(max, e.clientX - ox));
    knob.style.transform = `translateX(${dx}px)`;
    setTouchSpin(ramp(dx / max, 0.08));
  });
  const end = (e: PointerEvent | Event) => {
    if (pointer === null || (e instanceof PointerEvent && e.pointerId !== pointer)) return;
    if (track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
    pointer = null;
    track.classList.remove('active');
    knob.style.transform = '';
    setTouchSpin(null);
  };
  track.addEventListener('release', end);
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('lostpointercapture', end);
  track.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ loop

const DEMO_AT = { x: (SINGLE_W - 328) / 2, y: 32 };

function tick(dt: number) {
  if (state === 'title' || state === 'menu') demo.update(dt);
  else if (game) game.update(dt);
}

/** `alpha`: how far this frame is between the last two physics steps (0–1), so motion stays even at any refresh rate. */
function draw(alpha: number) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if ((state === 'title' || state === 'menu') && !game) {
    drawBackground(ctx, logicalW, H);
    drawField(ctx, demo.field, DEMO_AT, { dim: 0.35, alpha });
  } else if (game) {
    game.render(ctx, alpha);
  }
}

/** Longest stretch of missed time an online game makes up (a phone app suspended for a while) */
const CATCH_UP_MAX = 600;

let last = performance.now();
let acc = 0;

/**
 * Runs the physics steps due by `now`. Elsewhere a long gap (a background tab gets no frames) is
 * simply skipped, which pauses the game. Online the other player doesn't wait, so missed time is
 * made up: up to 30 steps a frame when drawn (a fast-forward, with this player's controls off), and
 * up to a minute's worth per call in a background tab, where nothing is drawn.
 */
function advance(now: number, hidden: boolean) {
  const online = game instanceof OnlineGame ? game : null;
  acc += Math.min(online ? CATCH_UP_MAX : 0.1, (now - last) / 1000);
  last = now;
  const max = !online ? 6 : hidden ? 3600 : 30;
  if (online) online.inputOff = menu.active || acc > 0.25;
  let steps = 0;
  while (acc >= STEP && steps < max) {
    tick(STEP);
    acc -= STEP;
    steps++;
  }
  if (!online && steps === max) acc = 0;
  online?.sendState(now);
}

// ------------------------------------------------------------------ cursor

/**
 * The mouse position in the window; null when it's outside. Tracked on the window rather than the
 * canvas, since a menu over the canvas would hide the moves made before a game starts.
 */
let mouseAt: { x: number; y: number } | null = null;
const trackMouse = (e: PointerEvent) => {
  if (e.pointerType === 'mouse') mouseAt = { x: e.clientX, y: e.clientY };
};
window.addEventListener('pointermove', trackMouse);
window.addEventListener('pointerdown', trackMouse);
document.documentElement.addEventListener('pointerleave', () => (mouseAt = null));

/**
 * Hides the mouse cursor while it's over a well where pieces are falling, so it never covers them;
 * it shows again over the side panel, when the game is paused, and once the pieces have fallen out
 * and the game-over popup is up. Checked every
 * frame, since the game can start, pause or end while the mouse stays still.
 */
function updateCursor() {
  const rects = mouseAt && state === 'game' && game ? game.liveRects() : [];
  let hide = false;
  if (rects.length) {
    const box = canvas.getBoundingClientRect();
    const x = (mouseAt!.x - box.left) / cssScale;
    const y = (mouseAt!.y - box.top) / cssScale;
    hide = rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }
  const cursor = hide ? 'none' : '';
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}

function frame(now: number) {
  pollPadPresses((code) => {
    if (menu.active || code === 'Enter') handleKey(code);
  });
  advance(now, false);
  draw(Math.min(1, acc / STEP));
  updateCursor();
  requestAnimationFrame(frame);
}

// A background tab gets no animation frames, so an online game runs on a clock there instead: the
// ticker worker, 20 times a second, so the other player still sees this field move smoothly. The
// page's own timer is the fallback; browsers slow that to about once a second in a background tab
// (each call then catches up on the time since the last).
const backgroundTick = () => {
  if (document.hidden && game?.type === 'online') advance(performance.now(), true);
};
let ticker: Worker | null = null;
try {
  ticker = new Worker(new URL('./ticker.ts', import.meta.url), { type: 'module' });
  ticker.addEventListener('message', backgroundTick);
  ticker.postMessage(document.hidden);
} catch {
  ticker = null;
}
document.addEventListener('visibilitychange', () => ticker?.postMessage(document.hidden));
window.setInterval(backgroundTick, 250);

applyTheme();
fit();
showTitle();
requestAnimationFrame(frame);

// Expose a tiny hook for debugging in the console.
(window as unknown as { slicefall: unknown }).slicefall = {
  get game() {
    return game;
  },
  get demo() {
    return demo;
  },
  resetDemo() {
    demo = new Demo();
  },
};
