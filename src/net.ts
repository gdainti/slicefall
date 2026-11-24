// The connection to the server's online Versus rooms (server/match.ts has the message list).

import type { StateMsg } from './online';
import type { PieceOrder } from './pieces';

/**
 * Why a room couldn't be used: the server's refusals, plus `offline` (couldn't connect at all) and
 * `lost` (the connection dropped).
 */
export type MatchError = 'not-found' | 'full' | 'busy' | 'limit' | 'offline' | 'lost';

export interface MatchEvents {
  room?(code: string): void;
  start?(seed: number, round: number, attacks: boolean, pieces: PieceOrder, hold: boolean): void;
  attack?(blocks: number): void;
  state?(msg: StateMsg): void;
  /** The other player topped out first: this player wins and should stop */
  won?(): void;
  /** win: null from a server that doesn't say, where the higher score won */
  result?(you: number, them: number, win: boolean | null): void;
  rematch?(): void;
  left?(): void;
  error?(e: MatchError): void;
}

export class MatchSocket {
  /** Handlers; screens swap these as the match moves on. */
  on: MatchEvents = {};
  private ws: WebSocket;
  /** Ended on purpose (or with a reason given), so the close that follows reports nothing */
  private done = false;

  /** `player`: the browser's random id (storage.ts), so the server's match log can tell players apart */
  constructor(
    hello: { t: 'create'; player: string; attacks: boolean; pieces: PieceOrder; hold: boolean } | { t: 'join'; code: string; player: string },
  ) {
    // Relative, like the leaderboard calls, so the game works from any path
    const url = new URL('api/match', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    url.hash = '';
    this.ws = new WebSocket(url);
    let opened = false;
    this.ws.addEventListener('open', () => {
      opened = true;
      this.ws.send(JSON.stringify(hello));
    });
    this.ws.addEventListener('message', (e) => {
      let m: { t?: string; [k: string]: unknown };
      try {
        m = JSON.parse(String(e.data)) as typeof m;
      } catch {
        return;
      }
      const on = this.on;
      switch (m.t) {
        case 'state':
          on.state?.(m as unknown as StateMsg);
          break;
        case 'room':
          on.room?.(String(m.code));
          break;
        case 'start':
          // A server from before a setting sends none: then random pieces, and no hold
          on.start?.(Number(m.seed), Number(m.round), m.attacks === true, m.pieces === 'bag' ? 'bag' : 'random', m.hold === true);
          break;
        case 'attack':
          if (Number.isInteger(m.n) && (m.n as number) > 0) on.attack?.(m.n as number);
          break;
        case 'won':
          on.won?.();
          break;
        case 'result':
          on.result?.(Number(m.you), Number(m.them), typeof m.win === 'boolean' ? m.win : null);
          break;
        case 'rematch':
          on.rematch?.();
          break;
        case 'left':
          this.done = true;
          on.left?.();
          break;
        case 'error':
          this.done = true;
          on.error?.(m.error as MatchError);
          break;
        default:
          break;
      }
    });
    this.ws.addEventListener('close', () => {
      if (this.done) return;
      this.done = true;
      this.on.error?.(opened ? 'lost' : 'offline');
    });
  }

  send(msg: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Leaves: the server closes the room and tells the other player. */
  close() {
    this.done = true;
    this.ws.close();
  }
}

export const CODE_LENGTH = 4;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Same rules as the server's normalizeCode. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_CHARS.includes(c)) return null;
  return code;
}
