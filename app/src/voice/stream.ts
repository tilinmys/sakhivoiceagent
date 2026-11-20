import { Platform } from 'react-native';

import type { Lang } from '@/i18n/strings';

import { vlog } from './log';

// Streaming STT: ONE WebSocket per check-in to the gateway's relay
// (sakhi_stream.py), which keeps one Gnani streaming session behind it.
//
//   while she speaks   her 20 ms PCM16 frames go out live (binary frames,
//                      no JSON, no base64): when she stops, Gnani already has
//                      the audio
//   commit()           at the endpointer's 250 ms pause and at the end of the
//                      turn: the turn's text so far comes back in ~190 ms
//                      (measured through the gateway, Wi-Fi and tunnel alike)
//   network            ping every 5 s; a drop reconnects at 200 ms -> 500 ms ->
//                      1 s -> every 2 s, without any "offline" alarm. A turn
//                      whose audio was cut by a drop is NOT patched up here:
//                      the engine transcribes that answer from its own full
//                      recording over HTTP (nothing is ever lost or duplicated)
//   routes             the gateway on this Wi-Fi (direct) and its public
//                      tunnel are raced; the first to say "ready" carries it
//
// Measured on the dev account (2026-11-13): Gnani's REST STT hangs ~5 s on 1
// call in 20; its stream did 40 / 40 with a 207 ms worst case.

const LAN = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LAN ?? '').replace(/\/+$/, '');
const PUBLIC_WS = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY_WS ?? '').replace(/\/+$/, '');
const LOCAL = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LOCAL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN ?? '';
const onLocalWeb = Platform.OS === 'web' && typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

const toWs = (base: string) => base.replace(/^http/, 'ws');
/** Where the stream may connect, fastest first in practice. */
export const STREAM_ROUTES = (onLocalWeb && LOCAL ? [LOCAL] : [LAN, PUBLIC_WS]).filter(Boolean).map((b) => `${toWs(b)}/stt/stream`);

const OPEN_MS = 4000;
const PING_MS = 5000;
/** No pong for this long: the socket is dead even if it never said so. */
const DEAD_MS = 12_000;
const RETRY_MS = [200, 500, 1000];
const RETRY_EVERY_MS = 2000;
/** The relay answers in ~150-250 ms, or says "fail" by 1.5 s: past 2 s the answer goes over HTTP. */
const COMMIT_MS = 2000;

type Pending = { resolve: (text: string | null) => void; timer: ReturnType<typeof setTimeout> };
type Reply = { t: string; turn?: number; id?: number; text?: string; ms?: number; at?: number; why?: string };

export class SttStream {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private closed = false;
  private retries = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private turnNo = 0;
  /** The current turn's audio reached the server without a gap (else: HTTP for this answer). */
  private intact = false;
  private seq = 0;
  private pending = new Map<number, Pending>();
  /** Round trip from the last pong (ms), for the log. */
  rttMs: number | null = null;

  constructor(private readonly lang: Lang) {}

  /** Usable right now (connected and ready). */
  get up() {
    return !!this.ws && this.ws.readyState === 1 && this.url !== null;
  }

  /** The current turn can be transcribed from the stream. */
  get turnIntact() {
    return this.up && this.intact;
  }

  start() {
    if (!STREAM_ROUTES.length) {
      vlog('stt', 'stream: no route configured (EXPO_PUBLIC_SAKHI_GATEWAY_LAN / _WS): HTTP only');
      return;
    }
    this.closed = false;
    this.connect();
  }

  close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.failAll();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  /** A new answer starts: its frames follow. */
  beginTurn() {
    this.turnNo++;
    this.failAll();
    this.intact = this.up;
    if (this.up) this.sendJson({ t: 'turn', turn: this.turnNo });
  }

  /** One frame of her answer (PCM16, 16 kHz mono). */
  send(pcm: Int16Array, offset = 0, n = pcm.length - offset) {
    if (!this.intact) return;
    if (!this.up) {
      this.intact = false; // a gap: this answer goes over HTTP
      return;
    }
    // A copy: the mic reuses its buffer for the next frame.
    this.ws!.send(pcm.slice(offset, offset + n).buffer);
  }

  /**
   * The turn's text so far (every segment since beginTurn). null when the
   * stream cannot give it (down, a gap in the audio, no reply in time): the
   * caller then transcribes the answer's own recording over HTTP.
   */
  commit(): Promise<string | null> {
    if (!this.turnIntact) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        vlog('stt', `stream: no text for commit ${id} in ${COMMIT_MS} ms`);
        resolve(null);
      }, COMMIT_MS);
      this.pending.set(id, { resolve, timer });
      this.sendJson({ t: 'commit', turn: this.turnNo, id });
    });
  }

  // ---- connection ---------------------------------------------------------

  private connect() {
    if (this.closed) return;
    const t = Date.now();
    let won = false;
    const sockets: WebSocket[] = [];
    STREAM_ROUTES.forEach((url) => {
      const ws = this.open(`${url}?lang=${this.lang}`);
      sockets.push(ws);
      const lose = () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
      const timer = setTimeout(lose, OPEN_MS);
      ws.onmessage = (e) => {
        const m = parse(e.data);
        if (!m) return;
        if (!won && m.t === 'ready') {
          won = true;
          clearTimeout(timer);
          sockets.filter((s) => s !== ws).forEach((s) => s.close());
          this.adopt(ws, url, Date.now() - t);
          return;
        }
        if (won && this.ws === ws) this.onReply(m);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.lost();
        else if (!won && sockets.every((s) => s.readyState === 3)) this.retry();
      };
    });
  }

  private open(url: string): WebSocket {
    if (!TOKEN) return new WebSocket(url);
    if (Platform.OS === 'web') return new WebSocket(`${url}&token=${encodeURIComponent(TOKEN)}`);
    const RNWebSocket = WebSocket as unknown as new (u: string, p: string[] | undefined, o: { headers: Record<string, string> }) => WebSocket;
    return new RNWebSocket(url, undefined, { headers: { Authorization: `Bearer ${TOKEN}` } });
  }

  private adopt(ws: WebSocket, url: string, ms: number) {
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.url = url;
    this.retries = 0;
    this.lastPong = Date.now();
    vlog('stt', `stream ready in ${ms} ms over ${url.startsWith('ws://') ? 'Wi-Fi (direct)' : 'the tunnel'}`);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > DEAD_MS) {
        vlog('stt', 'stream: no pong in 12 s, reconnecting');
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
        return;
      }
      this.sendJson({ t: 'ping', at: Date.now() });
    }, PING_MS);
  }

  private lost() {
    this.ws = null;
    this.url = null;
    this.intact = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.failAll();
    if (!this.closed) {
      vlog('stt', 'stream dropped: reconnecting (answers meanwhile go over HTTP)');
      this.retry();
    }
  }

  private retry() {
    if (this.closed) return;
    const wait = RETRY_MS[this.retries] ?? RETRY_EVERY_MS;
    this.retries++;
    setTimeout(() => this.connect(), wait);
  }

  private onReply(m: Reply) {
    if (m.t === 'pong') {
      this.lastPong = Date.now();
      if (typeof m.at === 'number') this.rttMs = Date.now() - m.at;
      return;
    }
    if ((m.t === 'text' || m.t === 'fail') && typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      // A reply for an older turn never answers this one.
      p.resolve(m.t === 'text' && m.turn === this.turnNo ? (m.text ?? '') : null);
    }
  }

  private failAll() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  private sendJson(m: object) {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch {
      // a closing socket: lost() follows
    }
  }
}

function parse(data: unknown): Reply | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as Reply;
  } catch {
    return null;
  }
}
