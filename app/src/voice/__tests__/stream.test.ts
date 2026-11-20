import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// The streaming STT client (voice/stream.ts): races its routes, streams binary
// frames, answers commits from the server's replies, never lets a reply for
// an old turn answer a new one, and on a drop reconnects (200 -> 500 -> 1000
// ms) while the engine falls back to HTTP for the answer that was cut.

type Sent = string | ArrayBuffer;
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: Sent[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: Sent) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  // server side
  ready() {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify({ t: 'ready' }) });
  }
  reply(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  json() {
    return this.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x) as { t: string; turn?: number; id?: number });
  }
}

function load() {
  process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LAN = 'http://192.168.0.12:8787/api/sakhi';
  process.env.EXPO_PUBLIC_SAKHI_GATEWAY_WS = 'https://pub.example/api/sakhi';
  process.env.EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN = 'tok';
  let mod!: typeof import('../stream');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../stream');
  });
  return mod;
}

beforeEach(() => {
  FakeSocket.all = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('SttStream', () => {
  it('races the Wi-Fi and tunnel routes; the first "ready" wins and the other is closed', () => {
    const { SttStream, STREAM_ROUTES } = load();
    expect(STREAM_ROUTES).toEqual(['ws://192.168.0.12:8787/api/sakhi/stt/stream', 'wss://pub.example/api/sakhi/stt/stream']);
    const s = new SttStream('kn');
    s.start();
    expect(FakeSocket.all.map((w) => w.url)).toEqual(['ws://192.168.0.12:8787/api/sakhi/stt/stream?lang=kn', 'wss://pub.example/api/sakhi/stt/stream?lang=kn']);
    FakeSocket.all[1].ready(); // the tunnel answers first
    expect(s.up).toBe(true);
    expect(FakeSocket.all[0].readyState).toBe(3);
  });

  it('streams binary frames and a commit returns the turn text', async () => {
    const { SttStream } = load();
    const s = new SttStream('kn');
    s.start();
    const ws = FakeSocket.all[0];
    ws.ready();
    s.beginTurn();
    s.send(new Int16Array(320).fill(5));
    expect(ws.sent.some((x) => typeof x !== 'string' && x.byteLength === 640)).toBe(true); // one 20 ms PCM16 frame, binary
    const p = s.commit();
    const c = ws.json().find((m) => m.t === 'commit')!;
    ws.reply({ t: 'text', turn: c.turn, id: c.id, text: 'ಇಲ್ಲ', ms: 160 });
    await expect(p).resolves.toBe('ಇಲ್ಲ');
  });

  it('a late reply for the previous answer never answers the current one', async () => {
    const { SttStream } = load();
    const s = new SttStream('kn');
    s.start();
    const ws = FakeSocket.all[0];
    ws.ready();
    s.beginTurn();
    s.send(new Int16Array(320));
    const old = s.commit();
    const c1 = ws.json().find((m) => m.t === 'commit')!;
    s.beginTurn(); // next question
    await expect(old).resolves.toBeNull(); // the old one is given up at once
    s.send(new Int16Array(320));
    const now = s.commit();
    ws.reply({ t: 'text', turn: c1.turn, id: c1.id, text: 'OLD' });
    const c2 = ws.json().filter((m) => m.t === 'commit')[1];
    ws.reply({ t: 'text', turn: c2.turn, id: c2.id, text: 'ಹೌದು' });
    await expect(now).resolves.toBe('ಹೌದು');
  });

  it('a drop mid-answer: that answer is marked for HTTP (commit gives null), then it reconnects 200 / 500 / 1000 ms', async () => {
    const { SttStream } = load();
    const s = new SttStream('kn');
    s.start();
    FakeSocket.all[0].ready();
    FakeSocket.all[1].close();
    s.beginTurn();
    s.send(new Int16Array(320));
    FakeSocket.all[0].close(); // the network blinks
    expect(s.turnIntact).toBe(false);
    await expect(s.commit()).resolves.toBeNull();
    const before = FakeSocket.all.length;
    jest.advanceTimersByTime(199);
    expect(FakeSocket.all.length).toBe(before);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(before + 2); // both routes tried again
    FakeSocket.all[before].ready();
    expect(s.up).toBe(true);
  });

  it('no reply in time: commit gives null (HTTP takes over), never hangs the turn', async () => {
    const { SttStream } = load();
    const s = new SttStream('kn');
    s.start();
    FakeSocket.all[0].ready();
    s.beginTurn();
    s.send(new Int16Array(320));
    const p = s.commit();
    jest.advanceTimersByTime(2000);
    await expect(p).resolves.toBeNull();
  });

  it('heartbeat: pings every 5 s; no pong for 12 s closes and reconnects', () => {
    const { SttStream } = load();
    const s = new SttStream('kn');
    s.start();
    const ws = FakeSocket.all[0];
    ws.ready();
    jest.advanceTimersByTime(5000);
    expect(ws.json().filter((m) => m.t === 'ping')).toHaveLength(1);
    jest.advanceTimersByTime(10_000);
    expect(ws.readyState).toBe(3);
  });
});
