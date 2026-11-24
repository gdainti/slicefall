import { audio } from './audio';
import * as C from './config';
import { Field, type FieldEvent, NO_CONTROLS, type Rotation } from './field';
import { singleControls, versusControls } from './input';
import { FieldEncoder, RemoteField, SEND_INTERVAL, type StateMsg } from './online';
import { MIRROR, type PieceOrder, pieceSequence, seededKinds } from './pieces';
import { COLORS, FONT, card, drawBackground, drawField, drawHeld, drawPreview, label, value } from './render';
import { highScores } from './storage';

export const H = 640;
export const SINGLE_W = 620;
export const VERSUS_W = 980;
export const SINGLE_FIELD = { x: 56, y: 32 };

/** Where the HTML pause button sits, in logical canvas pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A field's well plus its frame, for hiding the mouse cursor over it during play. */
function wellRect(f: { width: number }, at: { x: number; y: number }): Rect {
  return { x: at.x - 6, y: at.y - 6, w: f.width + 12, h: C.FIELD_HEIGHT + 12 };
}

function eventSound(e: FieldEvent) {
  switch (e) {
    case 'land':
      audio.play('land');
      break;
    case 'clear':
      audio.play('clear');
      break;
    case 'clear4':
      audio.play('clear4');
      break;
    case 'levelup':
      audio.play('levelup');
      break;
    case 'incoming':
      audio.play('warn');
      break;
    case 'garbage':
      audio.play('drop');
      break;
    case 'countered':
      audio.play('counter');
      break;
    case 'tspin':
      audio.play('tspin');
      break;
    default:
      break;
  }
}

/**
 * The label over (or under) a field's score: normally `text`, but right after a T-spin a blinking
 * T-SPIN! 😄 +points in its place.
 */
function scoreLabel(ctx: CanvasRenderingContext2D, f: Field, text: string, x: number, y: number, align: CanvasTextAlign = 'left') {
  if (f.tSpinTimer >= C.TSPIN_POPUP_TIME) return label(ctx, text, x, y, align);
  if (Math.floor(f.tSpinTimer / 0.1) % 2 === 0) value(ctx, `T-SPIN! 😄 +${f.lastTSpin}`, x, y + 1, 15, align, COLORS.accent);
}

export class SingleGame {
  readonly type = 'single';
  readonly field: Field;
  readonly best: number;
  readonly pauseRect: Rect = { x: 410, y: 32, w: 186, h: 38 };
  paused = false;
  /** Seconds of actual play (not paused, not the game-over fall), sent with the score. */
  elapsed = 0;

  constructor(
    private onOver: () => void,
    pieces: PieceOrder = 'bag',
    rotation: Rotation = 'free',
    hold = false,
  ) {
    this.field = new Field({ pickKind: pieceSequence(pieces), emit: (e) => this.onEvent(e), rotation, hold });
    this.best = highScores()[0]?.score ?? 0;
  }

  get width() {
    return SINGLE_W;
  }

  /** The Hold box, where a tap holds (touch screens have no key for it); null with hold off */
  get holdRect(): Rect | null {
    return this.field.holdEnabled ? { x: 503, y: 388, w: 93, h: 170 } : null;
  }

  start() {
    this.field.start();
  }

  /** The wells where pieces are falling right now (no cursor over them); empty when paused or over. */
  liveRects(): Rect[] {
    const s = this.field.state;
    return !this.paused && (s === 'playing' || s === 'cutting') ? [wellRect(this.field, SINGLE_FIELD)] : [];
  }

  private onEvent(e: FieldEvent) {
    eventSound(e);
    if (e === 'topout') {
      audio.stopMusic();
      audio.play('topout');
      this.field.startFallout();
    } else if (e === 'fallout') {
      audio.play('fallout');
    } else if (e === 'over') {
      this.onOver();
    }
  }

  update(dt: number) {
    if (this.paused) return;
    if (this.field.state === 'playing' || this.field.state === 'cutting') this.elapsed += dt;
    this.field.update(dt, singleControls());
  }

  render(ctx: CanvasRenderingContext2D, alpha = 1) {
    const f = this.field;
    drawBackground(ctx, SINGLE_W, H);
    drawField(ctx, f, SINGLE_FIELD, { hidePieces: this.paused, alpha });

    const px = 410;
    const pw = 186;

    // The pause button is an HTML element over pauseRect (y 32–70); the cards sit below it.
    const top = 82;
    card(ctx, px, top, pw, 290);
    scoreLabel(ctx, f, 'Score', px + 18, top + 34);
    value(ctx, String(f.score), px + 18, top + 72, 34);
    if (f.addTimer < C.SCORE_POPUP_TIME && !f.isCutting() && f.lastAdd > 0) {
      const t = f.addTimer / C.SCORE_POPUP_TIME;
      ctx.globalAlpha = 1 - t;
      value(ctx, `+${f.lastAdd}`, px + pw - 16, top + 34 - t * 14, 18, 'right', COLORS.accent);
      ctx.globalAlpha = 1;
    }
    label(ctx, 'Level', px + 18, top + 118);
    value(ctx, String(f.level), px + 18, top + 154, 30);
    label(ctx, 'Lines', px + 18, top + 200);
    value(ctx, String(f.lines), px + 18, top + 236, 30);
    label(ctx, 'Best', px + 18, top + 268);
    value(ctx, String(Math.max(this.best, f.score)), px + pw - 18, top + 268, 16, 'right', COLORS.dim);

    card(ctx, px, top + 306, pw, 170);
    if (f.holdEnabled) {
      // Next and Hold share the card, split down the middle
      const half = pw / 2;
      ctx.fillStyle = COLORS.cardLine;
      ctx.fillRect(px + half, top + 322, 1, 138);
      label(ctx, 'Next', px + half / 2, top + 336, 'center');
      label(ctx, 'Hold', px + half * 1.5, top + 336, 'center');
      if (!this.paused) {
        drawPreview(ctx, f.nextKind, px + half / 2, top + 406, f.nextSpin, 0.6);
        drawHeld(ctx, f, px + half * 1.5, top + 406, 0.6);
      }
    } else {
      label(ctx, 'Next', px + 18, top + 336);
      if (!this.paused) drawPreview(ctx, f.nextKind, px + pw / 2, top + 406, f.nextSpin, 0.78);
    }

    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'left';
    const hints = f.holdEnabled
      ? [
          ['← →  move', '↓  push'],
          ['Z X  rotate', 'C  hold'],
          ['or  A D S  ·  J K L', 'M  mute'],
        ]
      : [
          ['← →  move', '↓  push'],
          ['Z X  rotate', 'M  mute'],
          ['or  A D S  ·  J K rotate'],
        ];
    hints.forEach(([a, b], i) => {
      ctx.fillText(a, px + 18, 580 + i * 18);
      if (b) ctx.fillText(b, px + 112, 580 + i * 18);
    });
  }
}

type VersusPhase = 'countdown' | 'playing' | 'ending' | 'fallout' | 'done';

export class VersusGame {
  readonly type = 'versus';
  static wins: [number, number] = [0, 0];

  readonly fields: [Field, Field];
  readonly pauseRect: Rect = { x: 406, y: 32, w: 168, h: 36 };
  phase: VersusPhase = 'countdown';
  paused = false;
  winner: 0 | 1 | 2 = 2; // 2 = draw
  private seq: number[] = [];
  private countdown = 3;
  private lastBeep = 4;
  private endTimer = 0;
  /** Row meters go on the outer sides, so the layout mirrors around the centre panel. */
  private static readonly AT = [
    { x: 48, y: 32 },
    { x: 604, y: 32 },
  ];

  constructor(
    private onStart: () => void,
    private onDone: () => void,
    /** Cutting rows sends the other player blocks (Field.receiveAttack) */
    attacks = false,
    pieces: PieceOrder = 'bag',
    rotation: Rotation = 'free',
    hold = false,
  ) {
    // Both players get the same sequence; player 1 gets every piece mirrored (as in the original).
    const next = pieceSequence(pieces);
    const picker = (player: 0 | 1) => {
      let i = 0;
      return () => {
        while (this.seq.length <= i) this.seq.push(next());
        const k = this.seq[i++];
        return player === 0 ? MIRROR[k] : k;
      };
    };
    const attack = (to: 0 | 1) => (attacks ? (blocks: number) => this.fields[to].receiveAttack(blocks) : undefined);
    this.fields = [
      new Field({ pickKind: picker(0), emit: (e) => this.onEvent(0, e), attack: attack(1), rotation, hold }),
      new Field({ pickKind: picker(1), emit: (e) => this.onEvent(1, e), attack: attack(0), rotation, hold }),
    ];
  }

  get width() {
    return VERSUS_W;
  }

  start() {
    /* countdown runs in update() */
  }

  /** The wells where pieces are falling right now (no cursor over them); empty when paused or over. */
  liveRects(): Rect[] {
    if (this.paused || this.phase !== 'playing') return [];
    return this.fields.flatMap((f, i) => (f.state === 'playing' || f.state === 'cutting' ? [wellRect(f, VersusGame.AT[i])] : []));
  }

  private onEvent(player: 0 | 1, e: FieldEvent) {
    if (e === 'topout') audio.play('back');
    else if (e === 'fallout') {
      if (player === 0) audio.play('fallout');
    } else eventSound(e);
  }

  update(dt: number) {
    if (this.paused) return;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this.lastBeep && n > 0) audio.play('beep');
      this.lastBeep = n;
      if (this.countdown <= 0) {
        this.phase = 'playing';
        audio.play('go');
        this.fields.forEach((f) => f.start());
        this.onStart();
      }
      return;
    }

    // Once the round is decided, the winner's field stops where it is until the fall-out
    for (const i of [0, 1] as const) {
      const f = this.fields[i];
      if (this.phase === 'ending' && f.state !== 'toppedOut') continue;
      f.update(dt, this.phase === 'playing' ? versusControls(i) : NO_CONTROLS);
    }

    if (this.phase === 'playing') {
      // Whoever tops out first loses, whatever the scores; both in the same step is a draw
      const out = this.fields.map((f) => f.state === 'toppedOut');
      if (out[0] || out[1]) {
        const w = out[0] && out[1] ? 2 : out[0] ? 1 : 0;
        this.winner = w;
        if (w !== 2) VersusGame.wins[w] = (VersusGame.wins[w] + 1) % 100;
        this.phase = 'ending';
        this.endTimer = 0;
        audio.stopMusic();
        audio.play('topout');
      }
    } else if (this.phase === 'ending') {
      this.endTimer += dt;
      if (this.endTimer > 1.6) {
        this.fields.forEach((f) => f.startFallout());
        this.phase = 'fallout';
      }
    } else if (this.phase === 'fallout') {
      if (this.fields.every((f) => f.state === 'over')) {
        this.phase = 'done';
        this.onDone();
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, alpha = 1) {
    drawBackground(ctx, VERSUS_W, H);
    this.fields.forEach((f, i) => {
      const at = VersusGame.AT[i];
      const out = f.state === 'toppedOut' && (this.phase === 'playing' || this.phase === 'ending');
      drawField(ctx, f, at, { hidePieces: this.paused, dim: out ? 0.55 : 0, meter: i === 0 ? 'left' : 'right', alpha });
      if (out) centreText(ctx, 'TOPPED OUT', at.x + f.width / 2, at.y + C.FIELD_HEIGHT / 2, 26, COLORS.danger);
      if (this.phase === 'countdown') {
        centreText(ctx, String(Math.max(1, Math.ceil(this.countdown))), at.x + f.width / 2, at.y + C.FIELD_HEIGHT / 2, 110, COLORS.accent);
      }
    });

    // Centred between the fields, clear of the Retro brick walls (16 px each side of a field)
    const px = 406;
    const pw = 168;
    const cx = px + pw / 2;
    // The pause button is an HTML element over pauseRect (y 32–68); the cards sit below it.
    const top = 80;
    for (let i = 0; i < 2; i++) {
      const f = this.fields[i];
      const y = top + i * 200;
      card(ctx, px, y, pw, 184);
      label(ctx, `Player ${i + 1}`, cx, y + 30, 'center');
      value(ctx, String(f.score), cx, y + 76, 40, 'center');
      scoreLabel(ctx, f, 'score', cx, y + 96, 'center');
      if (f.holdEnabled) {
        // Next on the right, hold on the left, small
        ctx.fillStyle = COLORS.dim;
        ctx.font = `700 10px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('HOLD', cx - 40, y + 120);
        ctx.fillText('NEXT', cx + 40, y + 120);
        if (!this.paused && this.phase !== 'countdown') {
          drawHeld(ctx, f, cx - 40, y + 152, 0.42);
          drawPreview(ctx, f.nextKind, cx + 40, y + 152, f.nextSpin, 0.42);
        }
      } else if (!this.paused && this.phase !== 'countdown') drawPreview(ctx, f.nextKind, cx, y + 140, f.nextSpin, 0.55);
    }
    card(ctx, px, top + 400, pw, 72);
    label(ctx, 'Wins', cx, top + 426, 'center');
    value(ctx, `${VersusGame.wins[0]}  –  ${VersusGame.wins[1]}`, cx, top + 460, 26, 'center');

    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    const hints = this.fields[0].holdEnabled
      ? ['P1  A D S  ·  Q E rotate  ·  W hold', 'P2  J L K  ·  U O rotate  ·  I hold', '(P2 also ← → ↓  ·  , .  ·  ↑ hold)']
      : ['P1  A D S  ·  Q E rotate', 'P2  J L K  ·  U O rotate', '(P2 also ← → ↓  ·  , .)'];
    hints.forEach((h, i) =>
      ctx.fillText(h, cx, 572 + i * 16),
    );
  }
}

type OnlinePhase = 'countdown' | 'playing' | 'waiting' | 'ending' | 'fallout' | 'done';

/**
 * Versus against a player on another device. Only this player's field runs here; the other one is
 * drawn from the state messages their browser sends (RemoteField), small, in the side panel. Both
 * fields get the same pieces from the room's seed. Whoever tops out first loses: the server then
 * tells the other player ('won'), whose field stops where it is, and sends the result to both.
 *
 * Both games run at the same time: there is no pause. The page keeps the game going while it's in
 * the background and makes up any time it missed (main.ts), with `inputOff` set meanwhile.
 */
export class OnlineGame {
  readonly type = 'online';
  readonly field: Field;
  readonly remote = new RemoteField();
  /** Where the HTML button sits; online it's Leave rather than Pause */
  readonly pauseRect: Rect = { x: 410, y: 32, w: 186, h: 38 };
  phase: OnlinePhase = 'countdown';
  /** Only set once the room is gone, to stop the field where it is */
  paused = false;
  /** Ignore this player's controls: a menu is open over the game, or it is catching up on missed time */
  inputOff = false;
  result: { you: number; them: number; win: boolean | null } | null = null;
  /** This round's score has gone to the server (on topping out, or on being told we won) */
  private reported = false;
  private countdown = 3;
  private lastBeep = 4;
  private endTimer = 0;
  /** Seconds of play, sent with each state so the other side can space them out */
  private time = 0;
  private encoder = new FieldEncoder();
  /** Play time and page time (ms) of the last state sent, and whether the final one has gone */
  private sentTime = -1;
  private sentAt = -Infinity;
  private sentLast = false;

  /** Mini well of the other player: scale and top-left corner */
  private static readonly MINI = 0.46;
  private static readonly MINI_AT = { x: 503 - (328 * 0.46) / 2, y: 270 };

  constructor(
    seed: number,
    /** Rounds won in this room, [this player, the other]; updated when a round ends */
    readonly wins: [number, number],
    private send: (msg: object) => void,
    private onStart: () => void,
    private onDone: () => void,
    /** The room's setting: cutting rows sends the other player blocks */
    attacks = false,
    /** The room's setting: how the next piece is chosen */
    pieces: PieceOrder = 'random',
    /** This player's own setting: the other player's pieces arrive as positions, whatever theirs is */
    rotation: Rotation = 'free',
    /** The room's setting: hold can be used */
    hold = false,
  ) {
    this.field = new Field({
      rotation,
      hold,
      pickKind: seededKinds(seed, pieces),
      emit: (e) => this.onEvent(e),
      attack: attacks ? (blocks) => this.send({ t: 'attack', n: blocks }) : undefined,
    });
  }

  get width() {
    return SINGLE_W;
  }

  /** The hold preview, where a tap holds (touch screens have no key for it); null with hold off */
  get holdRect(): Rect | null {
    return this.field.holdEnabled ? { x: 500, y: 82, w: 96, h: 60 } : null;
  }

  start() {
    /* countdown runs in update() */
  }

  /** This player's well while pieces fall in it (no cursor over it); empty once the round is over. */
  liveRects(): Rect[] {
    const s = this.field.state;
    return !this.paused && this.phase === 'playing' && (s === 'playing' || s === 'cutting') ? [wellRect(this.field, SINGLE_FIELD)] : [];
  }

  receive(msg: StateMsg) {
    this.remote.receive(msg);
  }

  /** The other player cut rows: blocks for this field (ignored once this player has topped out). */
  receiveAttack(blocks: number) {
    if (this.phase === 'playing') this.field.receiveAttack(blocks);
  }

  /** The other player topped out first: this field stops where it is and its score goes in. */
  won() {
    if (this.phase !== 'playing' || this.reported) return;
    this.phase = 'waiting';
    this.report();
  }

  /** The round is decided: the final scores and whether this player won, from the server. */
  finish(you: number, them: number, win: boolean | null) {
    if (this.result) return;
    // A server from before the first-to-top-out rule doesn't say, and the higher score won there
    const w = win ?? (you > them ? true : them > you ? false : null);
    this.result = { you, them, win: w };
    if (w === true) this.wins[0]++;
    else if (w === false) this.wins[1]++;
    this.phase = 'ending';
    this.endTimer = 0;
    audio.stopMusic();
    audio.play('topout');
  }

  private onEvent(e: FieldEvent) {
    if (e === 'topout') {
      if (this.reported) return;
      audio.play('back');
      this.phase = 'waiting';
      this.report();
    } else if (e === 'fallout') audio.play('fallout');
    else eventSound(e);
  }

  private report() {
    this.reported = true;
    this.send({ t: 'over', score: this.field.score, tSpins: this.field.tSpins, tSpinPoints: this.field.tSpinPoints });
  }

  /** Won (the other player topped out first): this field stays where it is until the fall-out */
  private get frozen() {
    return (this.phase === 'waiting' || this.phase === 'ending') && this.field.state !== 'toppedOut';
  }

  update(dt: number) {
    this.remote.update(dt);
    if (this.paused) return;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this.lastBeep && n > 0) audio.play('beep');
      this.lastBeep = n;
      if (this.countdown <= 0) {
        this.phase = 'playing';
        audio.play('go');
        this.field.start();
        this.onStart();
      }
      return;
    }

    this.time += dt;
    // A frozen field doesn't move, but the round's end still runs: the winner's field stays frozen
    // until its fall-out starts, and only then the results come up
    if (!this.frozen) this.field.update(dt, this.phase === 'playing' && !this.inputOff ? singleControls() : NO_CONTROLS);

    if (this.phase === 'ending') {
      this.endTimer += dt;
      if (this.endTimer > 1.6) {
        this.field.startFallout();
        this.phase = 'fallout';
      }
    } else if (this.phase === 'fallout' && this.field.state === 'over') {
      this.phase = 'done';
      this.onDone();
    }
  }

  /**
   * Sends this field's state, called once per page frame after the steps. That's one message per
   * SEND_INTERVAL of play, but never more than about 20 a second of real time, so catching up on
   * missed time doesn't flood the server (it then sends fewer, further apart). Keeps going through
   * the fall-out, so the other player sees it too, and stops after the round's last state.
   */
  sendState(now: number) {
    if (this.paused || this.phase === 'countdown' || this.sentLast) return;
    // A little slack on the real-time limit, so frames that come early don't skip a message
    if (this.time - this.sentTime < SEND_INTERVAL - 1e-9 || now - this.sentAt < SEND_INTERVAL * 1000 * 0.9) return;
    this.sentTime = this.time;
    this.sentAt = now;
    this.sentLast = this.phase === 'done';
    this.send(this.encoder.encode(this.field, this.time));
  }

  render(ctx: CanvasRenderingContext2D, alpha = 1) {
    const f = this.field;
    const r = this.remote;
    drawBackground(ctx, SINGLE_W, H);

    const waiting = this.phase === 'waiting' && !this.frozen;
    drawField(ctx, f, SINGLE_FIELD, { dim: waiting ? 0.55 : 0, alpha });
    const fx = SINGLE_FIELD.x + f.width / 2;
    const fy = SINGLE_FIELD.y + C.FIELD_HEIGHT / 2;
    if (this.phase === 'countdown') centreText(ctx, String(Math.max(1, Math.ceil(this.countdown))), fx, fy, 110, COLORS.accent);
    if (waiting) {
      centreText(ctx, 'TOPPED OUT', fx, fy - 16, 26, COLORS.danger);
      centreText(ctx, 'the other player is still going', fx, fy + 20, 14, COLORS.dim);
    }

    const px = 410;
    const pw = 186;
    // The Leave button is an HTML element over pauseRect (y 32–70); the cards sit below it.
    let y = 82;
    card(ctx, px, y, pw, 96);
    scoreLabel(ctx, f, 'You', px + 18, y + 30);
    value(ctx, String(f.score), px + 18, y + 72, 30);
    // Hold and next, small, in a row at the top right (the score sits below them)
    if (this.phase !== 'playing') {
      /* no previews */
    } else if (f.holdEnabled) {
      drawHeld(ctx, f, px + pw - 70, y + 32, 0.28);
      drawPreview(ctx, f.nextKind, px + pw - 26, y + 32, f.nextSpin, 0.28);
    } else drawPreview(ctx, f.nextKind, px + pw - 42, y + 50, f.nextSpin, 0.4);

    y = 190;
    card(ctx, px, y, pw, 356);
    label(ctx, 'Opponent', px + 18, y + 30);
    value(ctx, String(r.score), px + 18, y + 66, 24);
    const k = OnlineGame.MINI;
    const at = OnlineGame.MINI_AT;
    const theyOut = r.state === 'toppedOut' && !this.result;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(k, k);
    drawField(ctx, r, { x: 0, y: 0 }, { meter: 'none', dim: theyOut ? 0.55 : 0, alpha });
    ctx.restore();
    const mx = at.x + (r.width * k) / 2;
    const my = at.y + (C.FIELD_HEIGHT * k) / 2;
    if (!r.live) centreText(ctx, 'GET READY', mx, my, 16, COLORS.dim);
    else if (theyOut) centreText(ctx, 'TOPPED OUT', mx, my, 16, COLORS.danger);

    y = 558;
    card(ctx, px, y, pw, 50);
    label(ctx, 'Wins', px + 18, y + 31);
    value(ctx, `${this.wins[0]} – ${this.wins[1]}`, px + pw - 18, y + 34, 22, 'right');
  }
}

export function centreText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string = COLORS.text) {
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, size / 7);
  ctx.strokeStyle = `rgba(${COLORS.veil}, 0.85)`;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textBaseline = 'alphabetic';
}
