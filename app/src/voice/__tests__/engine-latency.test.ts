import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SAKHI_REPLIES } from '@/data/mockScreening';
import { store } from '@/data/store';

// The turn as the phone lives it, in WALL-CLOCK time: mic frames every 20 ms,
// the stream's text back in 190 ms (measured through the gateway, Wi-Fi and
// tunnel alike), "ಸರಿ." played at its recorded length (0.6 s). Measures her
// last word -> Sakhi's first sound, and -> the next question.

const mockSttMs = 190;
const mockOkMs = 600;

jest.mock('../stream', () => ({
  SttStream: class {
    up = true;
    turnIntact = true;
    private said = '';
    static texts: string[] = [];
    start() {}
    close() {}
    beginTurn() {}
    send() {}
    commit() {
      return new Promise<string>((r) => setTimeout(() => r((this.constructor as unknown as { texts: string[] }).texts.shift() ?? 'ಕವಿತಾ'), mockSttMs));
    }
  },
}));
const mockTimeline: { what: string; at: number }[] = [];
jest.mock('../speaker', () => ({
  Speaker: class {
    checkDeviceVoice() {}
    async preloadRecorded() {}
    warm() {}
    prefetch() {
      return Promise.resolve(null);
    }
    async speak(t: string, onStart?: () => void) {
      mockTimeline.push({ what: t, at: Date.now() });
      onStart?.();
      await new Promise((r) => setTimeout(r, t.length < 12 ? mockOkMs : 40));
    }
    stop() {}
    release() {}
  },
}));
jest.mock('../mic', () => {
  class Mic {
    static last: Mic | null = null;
    on = false;
    stoppedAt = 0;
    cb: (pcm: Int16Array, off: number) => void;
    constructor(cb: (pcm: Int16Array, off: number) => void) {
      this.cb = cb;
      Mic.last = this;
    }
    starts = 0;
    stops = 0;
    async start() {
      if (this.on) return;
      this.starts++;
      this.on = true;
    }
    stop() {
      if (this.on) this.stops++;
      this.on = false;
    }
    dispose() {
      this.on = false;
    }
  }
  return { Mic, micSupported: true, micPermission: async () => true, playbackMode: async () => {}, unlockAudio: () => {}, AFTER_STOP_MS: 0 };
});
jest.mock('../gateway', () => ({ GatewayError: class extends Error {}, gateway: { offline: false, health: async () => ({ stt: true, tts: true }), stt: jest.fn(), warm: () => {} } }));
jest.mock('../db', () => ({
  voiceDb: { createSession: async () => {}, endSession: async () => {}, upsertTurn: async () => {}, updateTurn: async () => {}, logEvent: async () => {}, saveAnswer: async () => {}, answers: async () => [] },
}));
jest.mock('../answer-files', () => ({ saveAnswer: () => ({ uri: 'file://a.wav', ready: Promise.resolve(true) }), answerBody: () => ({}), deleteAnswer: () => {} }));

// eslint-disable-next-line import/first
import { SakhiEngine } from '../engine';

const micMod = jest.requireMock('../mic') as { Mic: { last: { cb: (p: Int16Array, o: number) => void; on: boolean; starts: number; stops: number } | null } };
let phase = 0;
let seed = 3;
const frame = (amp: number) => {
  const f = new Int16Array(320);
  for (let k = 0; k < 320; k++) {
    if (amp >= 200) f[k] = Math.round(amp * Math.SQRT2 * Math.sin((2 * Math.PI * 200 * phase++) / 16000));
    else f[k] = Math.round(amp * 1.7 * (((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1));
  }
  return f;
};
/** Frames at the mic's real pace (20 ms each). */
async function speakFor(amp: number, n: number, until?: () => boolean) {
  for (let k = 0; k < n && !(until?.() ?? false); k++) {
    micMod.Mic.last!.cb(frame(amp), 0);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function waitFor(pred: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

let e: SakhiEngine | null = null;
beforeEach(() => {
  store.resetDemo();
  mockTimeline.length = 0;
});
afterEach(() => e?.release());

describe('turn latency (wall clock, streaming STT)', () => {
  it('her last word -> Sakhi speaks in < 700 ms; -> the next question in < 1.4 s', async () => {
    const mother = store.get().find((m) => m.id === 'kavitha')!;
    e = new SakhiEngine(mother, 'kn', { warm: false, visit: 1, confirmMs: 0 });
    await e.start();
    await waitFor(() => e!.getSnapshot().stage === 'listening' && !!micMod.Mic.last?.on);
    await speakFor(26, 12);
    await speakFor(1300, 45); // ~0.9 s: "ನನ್ನ ಹೆಸರು ಕವಿತಾ"
    const lastWord = Date.now();
    const asked = mockTimeline.length;
    await speakFor(26, 80, () => !micMod.Mic.last!.on); // quiet until the turn ends
    await waitFor(() => mockTimeline.length >= asked + 2); // "ಸರಿ." and the next question
    const ok = mockTimeline.find((x, k) => k >= asked && x.what === SAKHI_REPLIES.kn.ok)!;
    const next = mockTimeline[mockTimeline.indexOf(ok) + 1];
    const toVoice = ok.at - lastWord;
    const toNext = next.at - lastWord;
    console.log(`last word -> "ಸರಿ." ${toVoice} ms; -> next question ${toNext} ms`);
    expect(toVoice).toBeLessThan(700);
    expect(toNext).toBeLessThan(1400);
  }, 20_000);

  it('ANDROID (mic kept open): no mic restart between turns, the echo of Sakhi is never taken as an answer, and the turn is faster', async () => {
    const mother = store.get().find((m) => m.id === 'kavitha')!;
    e = new SakhiEngine(mother, 'kn', { warm: false, visit: 1, confirmMs: 0, keepMic: true });
    await e.start();
    await waitFor(() => e!.getSnapshot().stage === 'listening' && !!micMod.Mic.last?.on);
    const mic = micMod.Mic.last!;
    await speakFor(26, 12);
    await speakFor(1300, 45);
    const lastWord = Date.now();
    const asked = mockTimeline.length;
    // keep feeding: the quiet room, then LOUD audio while Sakhi says "ಸರಿ" and the next question (her echo)
    let echoWhilePrompt = 0;
    for (let k = 0; k < 160 && mockTimeline.length < asked + 2; k++) {
      const loud = e!.getSnapshot().isPromptPlaying;
      if (loud) echoWhilePrompt++;
      micMod.Mic.last!.cb(frame(loud ? 3000 : 26), 0);
      await new Promise((r) => setTimeout(r, 20));
    }
    await waitFor(() => e!.getSnapshot().stage === 'listening' && e!.getSnapshot().idx === 1);
    const ok = mockTimeline.find((x, k) => k >= asked && x.what === SAKHI_REPLIES.kn.ok)!;
    const next = mockTimeline[mockTimeline.indexOf(ok) + 1];
    console.log(`android: last word -> "ಸರಿ." ${ok.at - lastWord} ms; -> next question ${next.at - lastWord} ms; mic starts ${mic.starts}, stops ${mic.stops}`);
    expect(mic.starts).toBe(1); // opened once for the whole check-in
    expect(mic.stops).toBe(0);
    expect(echoWhilePrompt).toBeGreaterThan(10); // the echo was really fed...
    expect(e!.getSnapshot().stage).toBe('listening'); // ...and never became an answer to Q2
    expect(e!.getSnapshot().answers.filter((a) => a.qid === 'age')).toHaveLength(0);
    expect(ok.at - lastWord).toBeLessThan(700);
  }, 20_000);
});
