import { World, Vec2, Polygon, type Body, type Fixture, type Contact } from 'planck';
import * as C from './config';
import {
  type Poly,
  clipAbove,
  clipBand,
  clipBelow,
  cleanPolygon,
  connectedGroups,
  largeEnough,
  polygonMass,
  shrinkPolygon,
  toLocal,
  toWorld,
  yRange,
  area,
} from './geometry';
import { GARBAGE, PIECE_SHAPES, T } from './pieces';

export interface Controls {
  left: boolean;
  right: boolean;
  down: boolean;
  rotL: boolean;
  rotR: boolean;
  /** Analog spin from the touch slider, -1 (full left) to 1 (full right); overrides rotL/rotR when set. */
  spin?: number;
  /** Analog sideways push from the touch joystick, -1 (full left) to 1 (full right); overrides left/right when set. */
  moveX?: number;
  /** Analog push down from the touch joystick, 0 (none) to 1 (full); overrides down when set. */
  drop?: number;
  /** Hold: swaps the falling piece with the held one (or puts it away and brings the next). A press, not a hold. */
  hold?: boolean;
}

/** free: rotate keys apply torque, so pieces turn to any angle; quarter: each press turns a quarter turn */
export type Rotation = 'free' | 'quarter';
export const ROTATIONS: Rotation[] = ['free', 'quarter'];

export const NO_CONTROLS: Controls = { left: false, right: false, down: false, rotL: false, rotR: false };

/**
 * incoming: the other player's attack arrived; garbage: waiting blocks dropped; countered: a cut
 * cancelled blocks that were waiting (Versus attacks).
 */
export type FieldEvent = 'tspin' | 'land' | 'clear' | 'clear4' | 'levelup' | 'topout' | 'fallout' | 'over' | 'incoming' | 'garbage' | 'countered';

export type FieldState = 'idle' | 'playing' | 'cutting' | 'toppedOut' | 'failing' | 'over';

export interface Piece {
  /** Unique within the field; online games use it to tell the other player which body moved. */
  id: number;
  body: Body;
  /** Polygons in body-local physics pixels (unshrunk; used for drawing, area and cutting). */
  shapes: Poly[];
  kind: number;
  /** Body position (physics pixels) and angle before the last physics step, for drawing in between steps. */
  prevX: number;
  prevY: number;
  prevAngle: number;
}

/** A block from the other player's attack, waiting at the top of its column (Field.receiveAttack) */
export interface Incoming {
  /** Column, 0 to GARBAGE_SLOTS - 1 (see slotX) */
  slot: number;
  /** A piece has landed since it came: it drops on the next landing that cuts nothing */
  armed: boolean;
}

/** Centre x of a garbage column, in physics pixels, for a well with these inner edges. */
export function slotX(left: number, width: number, slot: number): number {
  return left + C.BLOCK / 2 + (slot * (width - C.BLOCK)) / (C.GARBAGE_SLOTS - 1);
}

export interface PieceView {
  x: number;
  y: number;
  angle: number;
  shapes: Poly[];
  kind: number;
}

type WallSide = 'left' | 'right' | 'ground' | 'ceiling';
interface FixtureTag {
  wall?: WallSide;
  piece?: Piece;
}

interface FieldOptions {
  pickKind: () => number;
  emit?: (e: FieldEvent) => void;
  /**
   * Versus attacks: called with how many blocks to send the other player after a cut (once its
   * own waiting blocks are cancelled). Without it, cuts send nothing.
   */
  attack?: (blocks: number) => void;
  /** How the rotate controls turn the falling piece (default free) */
  rotation?: Rotation;
  /** Hold can be used (default off) */
  hold?: boolean;
}

const PX = C.PX_PER_M;
const v2 = (x: number, y: number) => Vec2(x / PX, y / PX);

export class Field {
  /** Inner edges of the side walls, in physics pixels. */
  readonly left: number;
  readonly right: number;

  state: FieldState = 'idle';
  pieces: Piece[] = [];
  active: Piece | null = null;
  nextKind: number;
  /** Hold can be used in this game (a setting) */
  readonly holdEnabled: boolean;
  /** The piece put away with hold, or null while there is none */
  heldKind: number | null = null;
  /** Hold was used for the falling piece: it can't be used again until a piece lands */
  holdUsed = false;
  speed = C.BASE_SPEED;

  score = 0;
  level = 0;
  lines = 0;
  placed = 0;
  /** How many times rows were cut, and the most rows one cut took (for the game log) */
  cuts = 0;
  bestCut = 0;
  lastAdd = 0;
  addTimer = C.SCORE_POPUP_TIME;
  nextSpin = 0;
  /** T-spins (full turns of a falling T) and the points they paid, for the game log */
  tSpins = 0;
  tSpinPoints = 0;
  /** Points of the latest T-spin, and how long since it (shows the T-SPIN! label until TSPIN_POPUP_TIME) */
  lastTSpin = 0;
  tSpinTimer = C.TSPIN_POPUP_TIME;

  /** Area held in each row, in px² (row is cut above CLEAR_THRESHOLD * BLOCK_AREA). */
  rowArea: number[] = new Array(C.ROWS).fill(0);
  removedRows: boolean[] = new Array(C.ROWS).fill(false);
  cutTimer = C.CLEAR_DURATION;
  /** What the field looked like right before the cut, drawn while the rows blink. */
  snapshot: PieceView[] = [];
  /** Blocks the other player sent, oldest first, waiting to drop */
  incoming: Incoming[] = [];

  private world: World;
  private ground: Fixture | null = null;
  private landed = false;
  private densityTimer = 0;
  private levelUpPending = false;
  private failTime = 0;
  private pickKind: () => number;
  private emit: (e: FieldEvent) => void;
  private attack: ((blocks: number) => void) | null;
  private nextId = 1;
  /** Blocks dropped on the last landing, and which of them have touched down; the next piece waits */
  private dropping = new Set<Piece>();
  private dropLanded = new Set<Piece>();
  private dropTimer = 0;
  /** The falling piece has made its T-spin: it can't make another */
  private spun = false;
  private _rotation: Rotation;
  /** 90° rotation: the angle the falling piece turns to and holds */
  private targetAngle = 0;
  /** 90° rotation: which way rotate was held last step (-1, 0, 1), so holding it turns only once */
  private rotHeld = 0;
  /** Hold was pressed last step, so keeping it down holds only once */
  private holdDown = false;

  constructor(opts: FieldOptions) {
    this.pickKind = opts.pickKind;
    this.emit = opts.emit ?? (() => {});
    this.attack = opts.attack ?? null;
    this._rotation = opts.rotation ?? 'free';
    this.holdEnabled = opts.hold ?? false;
    this.left = 56;
    this.right = 384;
    this.nextKind = this.pickKind();

    this.world = new World({ gravity: Vec2(0, C.GRAVITY / PX) });
    this.buildWalls();
    this.world.on('begin-contact', (c: Contact) => this.onContact(c));
  }

  get rotation(): Rotation {
    return this._rotation;
  }

  /** Changes rotation mid-game (from the pause menu): a falling piece squares up to its nearest quarter turn. */
  set rotation(r: Rotation) {
    this._rotation = r;
    const angle = this.active?.body.getAngle() ?? 0;
    this.targetAngle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    this.rotHeld = 0;
  }

  get width(): number {
    return this.right - this.left;
  }

  private buildWalls() {
    const walls = this.world.createBody({ type: 'static' });
    const rect = (x1: number, y1: number, x2: number, y2: number): Poly => [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
    ];
    const defs: [WallSide, Poly][] = [
      ['left', rect(this.left - 32, -128, this.left, 608)],
      ['right', rect(this.right, -128, this.right + 32, 608)],
      ['ground', rect(56, 576, 384, 608)],
      ['ceiling', rect(24, -160, 416, -128)],
    ];
    for (const [side, poly] of defs) {
      const f = this.addFixture(walls, poly, { wall: side });
      if (side === 'left' || side === 'right') f.setFriction(C.WALL_FRICTION);
      if (side === 'ground') this.ground = f;
    }
  }

  private addFixture(body: Body, shape: Poly, tag: FixtureTag): Fixture {
    const shrunk = shrinkPolygon(shape, C.FIXTURE_SHRINK) ?? shape;
    return body.createFixture({
      shape: new Polygon(shrunk.map((p) => v2(p.x, p.y))),
      density: C.DENSITY,
      friction: C.FRICTION,
      restitution: C.RESTITUTION,
      userData: tag,
    });
  }

  private createPiece(kind: number, shapes: Poly[], x: number, y: number, angle: number): Piece {
    const body = this.world.createBody({
      type: 'dynamic',
      position: v2(x, y),
      angle,
      linearDamping: C.LINEAR_DAMPING,
      bullet: true,
    });
    const piece: Piece = { id: this.nextId++, body, shapes, kind, prevX: x, prevY: y, prevAngle: angle };
    for (const s of shapes) this.addFixture(body, s, { piece });
    this.setMass(piece);
    return piece;
  }

  /** Mass from the unshrunk shapes, never lighter than MIN_MASS (settetrimass). */
  private setMass(piece: Piece) {
    let mass = 0;
    let cx = 0;
    let cy = 0;
    let I = 0;
    for (const s of piece.shapes) {
      const m = polygonMass(
        s.map((p) => ({ x: p.x / PX, y: p.y / PX })),
        C.DENSITY,
      );
      mass += m.mass;
      cx += m.cx * m.mass;
      cy += m.cy * m.mass;
      I += m.I;
    }
    if (mass <= 0) return;
    cx /= mass;
    cy /= mass;
    if (mass < C.MIN_MASS) {
      I *= C.MIN_MASS / mass;
      mass = C.MIN_MASS;
    }
    piece.body.setMassData({ mass, center: Vec2(cx, cy), I });
  }

  start() {
    this.state = 'playing';
    this.computeRowAreas();
    this.spawn();
  }

  private spawn(kind?: number) {
    if (kind === undefined) {
      kind = this.nextKind;
      this.nextKind = this.pickKind();
    }
    const p = this.createPiece(kind, PIECE_SHAPES[kind], C.SPAWN_X, C.SPAWN_Y, 0);
    p.body.setLinearVelocity(Vec2(0, this.speed / PX));
    this.active = p;
    this.spun = false;
    this.targetAngle = 0;
  }

  /**
   * A falling T that has turned a full circle from how it came in (either way, net, so wiggling
   * back and forth earns nothing) has made a T-spin. One per piece: turning on earns no more.
   */
  private checkTSpin() {
    const p = this.active;
    // Four presses would make one with 90° rotation, so there it earns nothing
    if (!p || p.kind !== T || this.spun || this._rotation === 'quarter') return;
    if (Math.abs(p.body.getAngle()) < Math.PI * 2) return;
    this.spun = true;
    const add = C.TSPIN_POINTS;
    this.tSpins++;
    this.tSpinPoints += add;
    this.score += add;
    this.lastTSpin = add;
    this.tSpinTimer = 0;
    this.emit('tspin');
  }

  private onContact(c: Contact) {
    const a = c.getFixtureA().getUserData() as FixtureTag | null;
    const b = c.getFixtureB().getUserData() as FixtureTag | null;
    // A dropped block is down once it touches anything but a side wall
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ]) {
      if (mine?.piece && this.dropping.has(mine.piece) && other?.wall !== 'left' && other?.wall !== 'right') this.dropLanded.add(mine.piece);
    }
    if (this.state !== 'playing' || !this.active) return;
    const aIsActive = a?.piece === this.active;
    const bIsActive = b?.piece === this.active;
    if (!aIsActive && !bIsActive) return;
    const other = aIsActive ? b : a;
    // Sliding along the side walls doesn't count as landing.
    if (other?.wall === 'left' || other?.wall === 'right') return;
    this.landed = true;
  }

  update(dt: number, controls: Controls) {
    // If this update doesn't step the world, prev == current and drawing between steps stays still.
    this.savePrevious();
    if (this.state === 'idle' || this.state === 'over') return;

    if (this.state === 'cutting') {
      this.cutTimer += dt;
      if (this.cutTimer >= C.CLEAR_DURATION) {
        this.cutTimer = C.CLEAR_DURATION;
        this.state = 'playing';
        this.addTimer = 0;
        this.computeRowAreas();
        if (this.levelUpPending) {
          this.levelUpPending = false;
          this.emit('levelup');
        }
      }
      return;
    }

    this.nextSpin = (this.nextSpin + C.NEXT_SPIN_SPEED * dt) % (Math.PI * 2);
    if (this.addTimer < C.SCORE_POPUP_TIME) this.addTimer = Math.min(C.SCORE_POPUP_TIME, this.addTimer + dt);
    if (this.tSpinTimer < C.TSPIN_POPUP_TIME) this.tSpinTimer = Math.min(C.TSPIN_POPUP_TIME, this.tSpinTimer + dt);

    if (this.state === 'playing' && this.active) this.applyControls(dt, controls);

    this.updateBullets();
    this.limitDropSpeed();
    this.landed = false;
    this.world.step(dt, C.VELOCITY_ITERATIONS, C.POSITION_ITERATIONS);
    if (this.state === 'playing') this.checkTSpin();
    if (this.landed && this.state === 'playing' && this.active) this.endBlock();
    if (this.dropping.size && this.state === 'playing') {
      this.dropTimer += dt;
      const down = [...this.dropping].every((p) => this.dropLanded.has(p));
      if (down || this.dropTimer >= C.GARBAGE_SPAWN_WAIT) this.endDrop();
    }

    // endBlock() may have just switched to 'cutting' (TS can't see that through the call).
    if ((this.state as FieldState) !== 'cutting') {
      this.densityTimer += dt;
      if (this.densityTimer >= C.DENSITY_INTERVAL) {
        this.densityTimer %= C.DENSITY_INTERVAL;
        this.computeRowAreas();
      }
    }

    if (this.state === 'failing') {
      this.failTime += dt;
      const allGone = this.pieces.every((p) => p.body.getPosition().y * PX >= C.FALLOUT_Y);
      if (allGone || this.failTime > 8) {
        this.state = 'over';
        this.emit('over');
      }
    }
  }

  /** Remembers where every piece is before a step, so frames drawn between steps can be placed in between. */
  private savePrevious() {
    const save = (p: Piece) => {
      const pos = p.body.getPosition();
      p.prevX = pos.x * PX;
      p.prevY = pos.y * PX;
      p.prevAngle = p.body.getAngle();
    };
    for (const p of this.pieces) save(p);
    if (this.active) save(this.active);
  }

  /**
   * Continuous collision ("bullet") keeps fast pieces from passing through each other, but with a
   * whole pile of bullets it's most of the cost of a step, and a hard landing that shakes the pile
   * made steps take several ms. The falling piece is always a bullet (it's created as one); settled
   * pieces only while they move fast, e.g. dropping after a cut or knocked by a landing piece.
   */
  private updateBullets() {
    const limit = (C.BULLET_SPEED / PX) ** 2;
    for (const p of this.pieces) {
      const v = p.body.getLinearVelocity();
      p.body.setBullet(v.x * v.x + v.y * v.y > limit);
    }
  }

  private applyControls(dt: number, k: Controls) {
    const press = !!k.hold && !this.holdDown;
    this.holdDown = !!k.hold;
    if (press && this.hold()) return;

    const body = this.active!.body;
    const spin = body.getAngularVelocity();
    if (this._rotation === 'quarter') {
      this.quarterRotate(k);
    } else if (k.spin !== undefined) {
      // Steer the spin towards the asked-for speed with up to the usual torque, so holding the
      // slider still (at 0) brakes the piece to a stop.
      const err = k.spin * C.MAX_SPIN - spin;
      body.applyTorque(C.TORQUE * Math.max(-1, Math.min(1, err / C.SPIN_EASE)), true);
    } else {
      if (k.rotR && spin < C.MAX_SPIN) body.applyTorque(C.TORQUE, true);
      if (k.rotL && spin > -C.MAX_SPIN) body.applyTorque(-C.TORQUE, true);
    }

    // Sideways: a force in proportion to the push; linear damping turns it into a matching speed.
    const centre = body.getWorldCenter();
    const side = k.moveX ?? Number(k.right) - Number(k.left);
    if (side) body.applyForce(Vec2(C.SIDE_FORCE * side, 0), centre, true);

    // Down: a partial push drops at a speed between the normal fall and the full drop speed.
    const drop = k.drop ?? (k.down ? 1 : 0);
    const vel = body.getLinearVelocity();
    const vy = vel.y * PX;
    if (drop > 0) {
      const limit = this.speed + (C.MAX_DROP_SPEED - this.speed) * drop;
      if (vy > limit) body.setLinearVelocity(Vec2(vel.x, Math.max(limit, vy - C.FALL_BRAKE * dt) / PX));
      else body.applyForce(Vec2(0, C.DOWN_FORCE * drop), centre, true);
    } else if (vy > this.speed) {
      body.setLinearVelocity(Vec2(vel.x, (vy - C.FALL_BRAKE * dt) / PX));
    }
  }

  /**
   * 90° rotation: a press (not a hold) of rotate turns the target a quarter turn, and the piece
   * is swung to it and held there. Knocks against the pile or walls can't tip it off square while
   * it falls; once it lands it is an ordinary body again. The touch slider presses when pushed far
   * enough to one side and must come back towards the middle before it presses again.
   */
  private quarterRotate(k: Controls) {
    let dir: number;
    if (k.spin !== undefined) {
      const a = Math.abs(k.spin);
      dir = a >= C.QUARTER_PRESS ? Math.sign(k.spin) : a > C.QUARTER_RELEASE ? this.rotHeld : 0;
    } else {
      dir = Number(k.rotR) - Number(k.rotL);
    }
    if (dir !== 0 && dir !== this.rotHeld) this.targetAngle += (dir * Math.PI) / 2;
    this.rotHeld = dir;

    const body = this.active!.body;
    const err = this.targetAngle - body.getAngle();
    body.setAngularVelocity(Math.max(-C.QUARTER_SPIN, Math.min(C.QUARTER_SPIN, err * C.QUARTER_GAIN)));
  }

  /**
   * Puts the falling piece away: the held one (if any) comes in at the top in its place, otherwise
   * the next one does. Once per piece, until one lands. True if it did.
   */
  private hold(): boolean {
    const piece = this.active;
    if (!piece || !this.holdEnabled || this.holdUsed || this.state !== 'playing') return false;
    const back = this.heldKind;
    this.heldKind = piece.kind;
    this.holdUsed = true;
    this.world.destroyBody(piece.body);
    this.active = null;
    this.spawn(back ?? undefined);
    return true;
  }

  private endBlock() {
    const piece = this.active!;
    this.active = null;
    this.holdUsed = false;
    this.pieces.push(piece);

    if (piece.body.getPosition().y * PX < C.LOSING_Y) {
      this.topOut();
      return;
    }

    this.placed++;
    const cut = this.checkRows();
    // The other player's blocks drop on a landing that cuts nothing, once a whole piece has passed
    // since they came; the ones that came during this piece wait for the next landing.
    if (!cut) this.dropGarbage();
    for (const b of this.incoming) b.armed = true;
    // Dropped blocks fall between pieces: the next one comes once they are down (see update)
    if (this.dropping.size === 0) this.spawn();
  }

  private topOut() {
    this.state = 'toppedOut';
    this.incoming = [];
    this.emit('topout');
  }

  /**
   * Versus: the other player cut rows and sends `blocks` single blocks. Each picks a free column
   * and waits at the top of it (drawn blinking) until it drops; see endBlock. Ignored once this
   * player has topped out.
   */
  receiveAttack(blocks: number) {
    if (this.state !== 'playing' && this.state !== 'cutting') return;
    const all = [...Array(C.GARBAGE_SLOTS).keys()];
    let added = 0;
    for (let i = 0; i < blocks && this.incoming.length < C.GARBAGE_MAX_QUEUE; i++) {
      const used = new Set(this.incoming.map((b) => b.slot));
      const free = all.filter((s) => !used.has(s));
      const pool = free.length ? free : all;
      this.incoming.push({ slot: pool[Math.floor(Math.random() * pool.length)], armed: false });
      added++;
    }
    if (added) this.emit('incoming');
  }

  /** Drops the armed blocks, one per column and at most GARBAGE_MAX_DROP; the rest wait. */
  private dropGarbage() {
    const used = new Set<number>();
    const waiting: Incoming[] = [];
    for (const b of this.incoming) {
      if (!b.armed || used.has(b.slot) || used.size >= C.GARBAGE_MAX_DROP) {
        waiting.push(b);
        continue;
      }
      used.add(b.slot);
      const p = this.createPiece(GARBAGE, PIECE_SHAPES[GARBAGE], slotX(this.left, this.width, b.slot), C.GARBAGE_SPAWN_Y, 0);
      p.body.setLinearVelocity(Vec2(0, C.GARBAGE_DROP_SPEED / PX));
      this.pieces.push(p);
      this.dropping.add(p);
    }
    this.incoming = waiting;
    if (used.size) {
      this.dropTimer = 0;
      this.emit('garbage');
    }
  }

  /** Dropped blocks fall no faster than GARBAGE_DROP_SPEED until they land, so they settle rather than smash. */
  private limitDropSpeed() {
    for (const p of this.dropping) {
      if (this.dropLanded.has(p)) continue;
      const v = p.body.getLinearVelocity();
      if (v.y * PX > C.GARBAGE_DROP_SPEED) p.body.setLinearVelocity(Vec2(v.x, C.GARBAGE_DROP_SPEED / PX));
    }
  }

  /** The dropped blocks are down (or took too long): the next piece comes, unless one rests above the line. */
  private endDrop() {
    const high = [...this.dropping].some((p) => p.body.getPosition().y * PX < C.LOSING_Y);
    this.dropping.clear();
    this.dropLanded.clear();
    if (high) this.topOut();
    else this.spawn();
  }

  /** Lets every piece drop out through the floor (the game-over animation). */
  startFallout() {
    if (this.state === 'failing' || this.state === 'over') return;
    if (this.active) {
      this.pieces.push(this.active);
      this.active = null;
    }
    this.state = 'failing';
    this.failTime = 0;
    this.incoming = [];
    this.dropping.clear();
    this.dropLanded.clear();
    if (this.ground) {
      this.ground.getBody().destroyFixture(this.ground);
      this.ground = null;
    }
    for (const p of this.pieces) p.body.setAwake(true);
    this.emit('fallout');
  }

  /** Row fill meter: area of all settled pieces inside each row. */
  computeRowAreas() {
    this.rowArea.fill(0);
    for (const p of this.pieces) {
      // Blocks still falling in don't fill rows on their way down
      if (this.dropping.has(p) && !this.dropLanded.has(p)) continue;
      const pos = p.body.getPosition();
      const angle = p.body.getAngle();
      for (const s of p.shapes) {
        const w = toWorld(s, pos.x * PX, pos.y * PX, angle);
        const [lo, hi] = yRange(w);
        const r0 = Math.max(0, Math.floor(lo / C.BLOCK));
        const r1 = Math.min(C.ROWS - 1, Math.floor(hi / C.BLOCK));
        for (let r = r0; r <= r1; r++) {
          const part = clipBand(w, r * C.BLOCK, (r + 1) * C.BLOCK);
          if (part.length >= 3) this.rowArea[r] += area(part);
        }
      }
    }
  }

  rowFullness(r: number): number {
    return Math.min(1, this.rowArea[r] / (C.BLOCK_AREA * C.CLEAR_THRESHOLD));
  }

  /** Cuts every row full enough after a landing; true if there were any. */
  private checkRows(): boolean {
    this.computeRowAreas();
    const rows: number[] = [];
    for (let r = 0; r < C.ROWS; r++) {
      if (this.rowArea[r] > C.BLOCK_AREA * C.CLEAR_THRESHOLD) rows.push(r);
    }
    if (rows.length === 0) {
      this.emit('land');
      return false;
    }

    this.state = 'cutting';
    this.cutTimer = 0;
    this.snapshot = this.views();
    this.removedRows.fill(false);
    for (const r of rows) this.removedRows[r] = true;

    const n = rows.length;
    this.emit(n >= 4 ? 'clear4' : 'clear');

    // Scoring from the original: rewards both the number of rows and how densely they were packed.
    const avg = rows.reduce((s, r) => s + this.rowArea[r], 0) / n / (C.BLOCK_AREA * 10);
    const add = Math.ceil(Math.pow(n * 3, Math.pow(avg, 10)) * 20 + n * n * 40);
    this.score += add;
    this.lastAdd = add;
    this.addTimer = C.SCORE_POPUP_TIME;

    this.lines += n;
    this.cuts++;
    this.bestCut = Math.max(this.bestCut, n);
    if (Math.floor(this.lines / 10) > this.level) {
      this.level++;
      this.speed = C.BASE_SPEED + this.level * C.SPEED_PER_LEVEL;
      this.levelUpPending = true;
    }

    for (const r of rows) this.removeRow(r);
    // Pieces that rested on something that vanished must not stay asleep in mid-air.
    for (const p of this.pieces) p.body.setAwake(true);

    if (this.attack) {
      // A cut first cancels blocks still waiting here, oldest first; only the rest is sent
      let send = C.ATTACK_BLOCKS[Math.min(n, C.ATTACK_BLOCKS.length - 1)];
      const cancel = Math.min(send, this.incoming.length);
      if (cancel) {
        this.incoming.splice(0, cancel);
        this.emit('countered');
      }
      send -= cancel;
      if (send > 0) this.attack(send);
    }
    return true;
  }

  /** Slices every settled piece along the row's top and bottom edge and drops what was inside. */
  private removeRow(row: number) {
    const top = row * C.BLOCK;
    const bottom = top + C.BLOCK;
    const kept: Piece[] = [];

    for (const p of this.pieces) {
      const pos = p.body.getPosition();
      const x = pos.x * PX;
      const y = pos.y * PX;
      const angle = p.body.getAngle();
      const world = p.shapes.map((s) => toWorld(s, x, y, angle));
      const touches = world.some((w) => {
        const [lo, hi] = yRange(w);
        return lo < bottom && hi > top;
      });
      if (!touches) {
        kept.push(p);
        continue;
      }

      const parts: Poly[] = [];
      for (const w of world) {
        for (const part of [clipAbove(w, top), clipBelow(w, bottom)]) {
          if (part.length < 3) continue;
          const clean = cleanPolygon(part);
          if (clean.length >= 3 && clean.length <= 8 && largeEnough(clean, C.MIN_SIDE_DIST)) parts.push(clean);
        }
      }

      this.world.destroyBody(p.body);
      if (parts.length === 0) continue;

      // Whatever is left may have fallen apart into separate chunks; each becomes its own body.
      for (const group of connectedGroups(parts, 2)) {
        const local = group.map((g) => toLocal(g, x, y, angle));
        kept.push(this.createPiece(p.kind, local, x, y, angle));
      }
    }
    this.pieces = kept;
  }

  /**
   * Where to draw each piece. Physics steps at a fixed 60 Hz while screens refresh at their own rate
   * (often 120 Hz), so `alpha` (0–1) places pieces that far from the previous step towards the last
   * one. Without it a fast drop moves 0 px, then a whole step, then 0 px again from frame to frame.
   */
  views(alpha = 1): PieceView[] {
    const out: PieceView[] = [];
    const add = (p: Piece) => {
      const pos = p.body.getPosition();
      const angle = p.body.getAngle();
      out.push({
        x: p.prevX + (pos.x * PX - p.prevX) * alpha,
        y: p.prevY + (pos.y * PX - p.prevY) * alpha,
        angle: p.prevAngle + (angle - p.prevAngle) * alpha,
        shapes: p.shapes,
        kind: p.kind,
      });
    };
    for (const p of this.pieces) add(p);
    if (this.active) add(this.active);
    return out;
  }

  isCutting(): boolean {
    return this.state === 'cutting';
  }

  /** Blink phase for cut rows, as in the original (odd sections are lit). */
  rowsLit(): boolean {
    const section = Math.ceil(this.cutTimer / (C.CLEAR_DURATION / C.CLEAR_BLINKS));
    return section % 2 === 1 || this.cutTimer === 0;
  }
}
