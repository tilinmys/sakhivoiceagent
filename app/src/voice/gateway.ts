import { fetch } from 'expo/fetch';
import { Platform } from 'react-native';

import type { Lang } from '@/i18n/strings';

import { vlog } from './log';
import type { TtsPriority } from './tts-queue';

export type { TtsPriority };

// Transport layer: the app's only network path for voice (HTTPS to the
// Sakhi gateway, api/index.py). Provider keys never live on the phone.
//   health()  which providers the server has (decides live vs demo mode)
//   ttsUrl()  a stable URL per text, so the CDN and the phone can cache it
//   stt()     one answer (WAV) -> native transcript + English translation
// Every call has a hard timeout. A circuit breaker stops hammering a dead
// network: 3 failures in a row -> "offline" for 30 s, answers go to the
// outbox and the conversation carries on (docs/VOICE_IN_APP_DESIGN.md 4.3).

const PUBLIC = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY ?? '').replace(/\/+$/, '');
// The desktop browser (Expo web on localhost) talks to the gateway on this
// PC directly: no tunnel hop. Written by scripts/sakhi_gateway_dev.py.
const LOCAL = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LOCAL ?? '').replace(/\/+$/, '');
const onLocalWeb = Platform.OS === 'web' && typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
const BASE = onLocalWeb && LOCAL ? LOCAL : PUBLIC;
// Expo Go on a phone on the same Wi-Fi as the dev PC reaches the gateway
// DIRECTLY (written by scripts/sakhi_gateway_dev.py). Measured from the PC:
// the tunnel is ~60-80 ms a request warm and ~700 ms cold; the LAN ~5-20 ms.
// Both are raced at health() and the first to answer carries the
// request/response traffic (STT, TTS). The live / WebSocket paths stay on
// BASE (they need the public HTTPS host).
const LAN = (process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LAN ?? '').replace(/\/+$/, '');
const ROUTES = onLocalWeb || !LAN ? [BASE] : [LAN, BASE].filter((b, i, a) => b && a.indexOf(b) === i);
/** The route STT / TTS use now (the race winner; falls back to BASE when the LAN fails). */
let route = BASE;
/** Last request on `route`: an idle connection is re-warmed before she finishes speaking. */
let lastUse = 0;
const WARM_AFTER_MS = 10_000;
const TOKEN = process.env.EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN ?? '';
const OPEN_MS = 30_000;
const TRIP_AFTER = 3;

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type SttResult = { text: string; en: string; ms: number };

let fails = 0;
let openUntil = 0;

const headers = (): Record<string, string> => (TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(ctrl.signal.aborted ? 'timeout' : `network: ${String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** The first promise to resolve; rejects with every error only when all reject (Promise.any, which Hermes may lack). */
function firstOk<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const errs: unknown[] = [];
    ps.forEach((p) =>
      p.then(resolve, (e) => {
        errs.push(e);
        if (errs.length === ps.length) reject(errs);
      }),
    );
  });
}

function record(ok: boolean) {
  if (ok) {
    fails = 0;
    return;
  }
  fails++;
  if (fails >= TRIP_AFTER) openUntil = Date.now() + OPEN_MS;
}

export const gateway = {
  /** Set at build time with EXPO_PUBLIC_SAKHI_GATEWAY (e.g. https://<app>.vercel.app/api/sakhi). */
  configured: BASE.length > 0,

  /** True while the breaker is open: skip the network, use the outbox. */
  get offline() {
    return Date.now() < openUntil;
  },

  async health(): Promise<{ stt: boolean; tts: boolean }> {
    if (!BASE) {
      vlog('gate', 'NOT CONFIGURED (EXPO_PUBLIC_SAKHI_GATEWAY is empty): demo mode, phone voice only');
      return { stt: false, tts: false };
    }
    // Race every route; the first healthy answer wins (lowest round trip) and
    // its connection is now open and warm for the first answer's upload.
    const t = Date.now();
    const probe = (base: string) =>
      withTimeout(5000, async (signal) => {
        const res = await fetch(`${base}/health`, { headers: headers(), signal });
        if (!res.ok) throw new GatewayError(`health ${res.status}`, true);
        const body = (await res.json()) as { stt?: boolean; tts?: boolean; provider?: string };
        return { base, body, ms: Date.now() - t };
      });
    try {
      const win = await firstOk(ROUTES.map(probe));
      route = win.base;
      lastUse = Date.now();
      const { body } = win;
      vlog('gate', `${route} ok ${win.ms} ms${ROUTES.length > 1 ? ` (fastest of ${ROUTES.length} routes)` : ''}, provider ${body.provider ?? '?'}, stt ${!!body.stt}, tts ${!!body.tts}`);
      return { stt: !!body.stt, tts: !!body.tts };
    } catch (e) {
      const errs = Array.isArray(e) ? e : [e];
      vlog('err', `gateway unreachable after ${Date.now() - t} ms (${ROUTES.join(', ')}): ${errs.map((x) => String((x as Error)?.message ?? x)).join('; ')}`);
      return { stt: false, tts: false };
    }
  },

  /** The route STT / TTS go over now (for the log and tests). */
  get route() {
    return route;
  },

  /**
   * Keep the connection warm: called when she starts speaking. An idle
   * connection (TCP + TLS, and the tunnel's own hop) costs ~0.6 s on the
   * first request after a pause; a tiny health request now, while she is
   * still talking, means her answer's upload rides an open connection.
   */
  warm() {
    if (!BASE || this.offline || Date.now() - lastUse < WARM_AFTER_MS) return;
    lastUse = Date.now();
    withTimeout(4000, (signal) => fetch(`${route}/health`, { headers: headers(), signal })).catch(() => {});
  },

  ttsUrl(text: string, lang: Lang) {
    return `${route}/tts?lang=${lang}&text=${encodeURIComponent(text)}`;
  },

  ttsHeaders: (prio: TtsPriority): Record<string, string> => ({ ...headers(), 'X-Sakhi-Priority': prio }),

  // ---- Live Sakhi (WebRTC through LiveKit, see voice/live.ts) --------------

  /** The page that holds the WebRTC connection (loaded in a WebView / iframe). */
  livePageUrl: BASE ? `${BASE}/live/page` : '',

  /** Is live Sakhi possible right now (LiveKit configured, agent up)? */
  async liveConfig(): Promise<{ available: boolean; url: string | null; agentReady: boolean | null }> {
    if (!BASE) return { available: false, url: null, agentReady: false };
    const t = Date.now();
    try {
      return await withTimeout(4000, async (signal) => {
        const res = await fetch(`${BASE}/live/config`, { headers: headers(), signal });
        if (!res.ok) throw new GatewayError(`live config ${res.status}`, true);
        const c = (await res.json()) as { available: boolean; url: string | null; agentReady: boolean | null };
        vlog('gate', `live: ${c.available ? 'available' : 'NOT configured'}, agent ${c.agentReady === null ? 'unknown' : c.agentReady ? 'up' : 'DOWN'} (${Date.now() - t} ms)`);
        return c;
      });
    } catch (e) {
      vlog('err', `live config failed: ${String((e as Error)?.message ?? e)}`);
      return { available: false, url: null, agentReady: false };
    }
  },

  /** A room + token for one live conversation (Sakhi is dispatched into it). */
  async liveSession(lang: Lang, mother: { id: string; name: string; months?: number }): Promise<{ url: string; token: string; room: string }> {
    if (!BASE) throw new GatewayError('not configured', false);
    return withTimeout(8000, async (signal) => {
      const res = await fetch(`${BASE}/live/session`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, mother }),
        signal,
      });
      if (!res.ok) throw new GatewayError(`live session ${res.status}`, res.status >= 500);
      return (await res.json()) as { url: string; token: string; room: string };
    });
  },

  // ---- Sakhi Direct (one WebSocket per check-in, see voice/direct.ts) ------

  /** wss://<gateway>/api/sakhi/ws (same host and tunnel as every other call). */
  wsUrl: BASE ? `${BASE.replace(/^http/, 'ws')}/ws` : '',

  /**
   * Open the Sakhi Direct socket. Phones send the token as a header (React
   * Native's WebSocket takes headers), so it never sits in a URL a proxy
   * might log; a browser cannot set WebSocket headers, so it uses ?token=.
   */
  openSocket(): WebSocket {
    if (!TOKEN) return new WebSocket(this.wsUrl);
    if (Platform.OS === 'web') return new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(TOKEN)}`);
    const RNWebSocket = WebSocket as unknown as new (url: string, protocols: string[] | undefined, options: { headers: Record<string, string> }) => WebSocket;
    return new RNWebSocket(this.wsUrl, undefined, { headers: { Authorization: `Bearer ${TOKEN}` } });
  },

  /** One line's audio as WAV bytes (the web speaker keeps them in memory). */
  async tts(text: string, lang: Lang, prio: TtsPriority, timeoutMs = 15_000): Promise<ArrayBuffer> {
    if (!BASE) throw new GatewayError('not configured', false);
    return withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(this.ttsUrl(text, lang), { headers: this.ttsHeaders(prio), signal });
      if (!res.ok) throw new GatewayError(`tts ${res.status}`, res.status === 429 || res.status >= 500);
      return res.arrayBuffer();
    });
  },

  /**
   * One answer. `body` is the WAV as a file (streamed from disk, never read
   * into JS memory) or bytes. Throws GatewayError (retryable or not).
   */
  async stt(body: Blob | Uint8Array, lang: Lang, timeoutMs = 8000): Promise<SttResult> {
    if (!BASE) throw new GatewayError('not configured', false);
    if (this.offline) throw new GatewayError('offline', true);
    try {
      const out = await withTimeout(timeoutMs, async (signal) => {
        lastUse = Date.now();
        const res = await fetch(`${route}/stt?lang=${lang}`, {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'audio/wav' },
          body: body as Blob,
          signal,
        });
        if (!res.ok) {
          const retry = res.status === 429 || res.status >= 500;
          throw new GatewayError(`stt ${res.status}`, retry);
        }
        return (await res.json()) as SttResult;
      });
      record(true);
      return out;
    } catch (e) {
      const err = e instanceof GatewayError ? e : new GatewayError(String(e), true);
      // The Wi-Fi route failed at the network level (she walked out of range,
      // another network): straight to the tunnel; the caller's retry uses it.
      if (route !== BASE && !/^stt \d/.test(err.message)) {
        vlog('gate', `LAN route failed (${err.message}): switching to ${BASE}`);
        route = BASE;
        throw err;
      }
      // Only a dead NETWORK trips the breaker. A reachable gateway that
      // answered 5xx / 429 (the provider hung or was busy: measured, 1 call
      // in 20 on Gnani REST) is not "no internet": it must never show offline.
      if (err.retryable && !/^stt \d/.test(err.message)) record(false);
      throw err;
    }
  },
};
