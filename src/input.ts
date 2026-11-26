import type { Controls } from './field';

type Action = Exclude<keyof Controls, 'spin' | 'moveX' | 'drop'>;
type KeyMap = Record<Action, string[]>;

// Rotation is on Z / X, or J / K to pair with WASD; hold on C or Shift (or L); Up does nothing during play.
export const KEYS_SINGLE: KeyMap = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  down: ['ArrowDown', 'KeyS'],
  rotL: ['KeyZ', 'KeyJ'],
  rotR: ['KeyX', 'KeyK'],
  hold: ['KeyC', 'ShiftLeft', 'ShiftRight', 'KeyL'],
};

export const KEYS_P1: KeyMap = {
  left: ['KeyA'],
  right: ['KeyD'],
  down: ['KeyS'],
  rotL: ['KeyQ'],
  rotR: ['KeyE'],
  hold: ['KeyW'],
};

export const KEYS_P2: KeyMap = {
  left: ['ArrowLeft', 'KeyJ'],
  right: ['ArrowRight', 'KeyL'],
  down: ['ArrowDown', 'KeyK'],
  rotL: ['KeyU', 'Comma', 'Numpad1'],
  rotR: ['KeyO', 'Period', 'Numpad2'],
  hold: ['KeyI', 'ArrowUp', 'Slash', 'Numpad3'],
};

const held = new Set<string>();
/** Keys still held from a menu press: ignored by the game until released (controls.held in the original). */
const suppressed = new Set<string>();
/** On-screen buttons held down. */
const touch = new Set<Action>();
/** The touch spin slider, -1..1, or null while it is not being touched. */
let touchSpin: number | null = null;
/** The touch joystick: x -1..1 sideways, y 0..1 down; null while it is not being touched. */
let touchMove: { x: number; y: number } | null = null;
/** A tap on the Hold box, not yet seen by the game (singleControls reports it once). */
let touchHold = false;

window.addEventListener('keydown', (e) => held.add(e.code));
window.addEventListener('keyup', (e) => {
  held.delete(e.code);
  suppressed.delete(e.code);
});
window.addEventListener('blur', () => {
  held.clear();
  suppressed.clear();
  touch.clear();
  touchSpin = null;
  touchMove = null;
  touchHold = false;
});

export function suppressHeldKeys() {
  for (const k of held) suppressed.add(k);
  padSuppressed = true;
}

function keyDown(code: string) {
  return held.has(code) && !suppressed.has(code);
}

// ---------------------------------------------------------------- gamepads

let padSuppressed = false;

function padControls(index: number): Controls {
  const none: Controls = { left: false, right: false, down: false, rotL: false, rotR: false, hold: false };
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads[index];
  if (!pad) return none;
  const b = (i: number) => !!pad.buttons[i]?.pressed;
  const ax = pad.axes[0] ?? 0;
  const ay = pad.axes[1] ?? 0;
  const c: Controls = {
    left: b(14) || ax < -0.45,
    right: b(15) || ax > 0.45,
    down: b(13) || ay > 0.55,
    rotR: b(0) || b(5) || b(7),
    rotL: b(1) || b(2) || b(4) || b(6),
    hold: b(3),
  };
  if (padSuppressed) {
    if (Object.values(c).some(Boolean)) return none;
    padSuppressed = false;
  }
  return c;
}

/** Edge-triggered gamepad buttons, turned into virtual key presses for menus/pause. */
const prevPad = new Map<string, boolean>();
export function pollPadPresses(onPress: (code: string) => void) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad) continue;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const map: [string, boolean][] = [
      ['ArrowUp', !!pad.buttons[12]?.pressed || ay < -0.6],
      ['ArrowDown', !!pad.buttons[13]?.pressed || ay > 0.6],
      ['ArrowLeft', !!pad.buttons[14]?.pressed || ax < -0.6],
      ['ArrowRight', !!pad.buttons[15]?.pressed || ax > 0.6],
      ['Enter', !!pad.buttons[9]?.pressed],
      ['PadA', !!pad.buttons[0]?.pressed],
      ['Escape', !!pad.buttons[1]?.pressed || !!pad.buttons[8]?.pressed],
    ];
    for (const [code, on] of map) {
      const key = `${pad.index}:${code}`;
      if (on && !prevPad.get(key)) onPress(code);
      prevPad.set(key, on);
    }
  }
}

// ---------------------------------------------------------------- touch

export function setTouchSpin(spin: number | null) {
  touchSpin = spin;
}

export function setTouch(action: Action, on: boolean) {
  if (on) touch.add(action);
  else touch.delete(action);
}

/** The Hold box was tapped: the next step holds. */
export function pressTouchHold() {
  touchHold = true;
}

export function setTouchMove(move: { x: number; y: number } | null) {
  touchMove = move;
}

export function clearTouch() {
  touch.clear();
  touchSpin = null;
  touchMove = null;
  touchHold = false;
}

// ---------------------------------------------------------------- combined

function fromKeys(map: KeyMap): Controls {
  const r = (a: Action) => map[a].some(keyDown);
  return { left: r('left'), right: r('right'), down: r('down'), rotL: r('rotL'), rotR: r('rotR'), hold: r('hold') };
}

function or(a: Controls, b: Controls): Controls {
  return {
    left: a.left || b.left,
    right: a.right || b.right,
    down: a.down || b.down,
    rotL: a.rotL || b.rotL,
    rotR: a.rotR || b.rotR,
    hold: !!(a.hold || b.hold),
  };
}

export function singleControls(): Controls {
  const t: Controls = {
    left: touch.has('left'),
    right: touch.has('right'),
    down: touch.has('down'),
    rotL: touch.has('rotL'),
    rotR: touch.has('rotR'),
    hold: touchHold,
  };
  touchHold = false;
  const c = or(or(fromKeys(KEYS_SINGLE), padControls(0)), t);
  if (touchSpin !== null) c.spin = touchSpin;
  if (touchMove) {
    c.moveX = touchMove.x;
    c.drop = touchMove.y;
  }
  return c;
}

export function versusControls(player: 0 | 1): Controls {
  return or(fromKeys(player === 0 ? KEYS_P1 : KEYS_P2), padControls(player));
}
