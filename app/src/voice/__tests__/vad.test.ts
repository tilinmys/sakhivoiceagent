import { describe, expect, it } from '@jest/globals';

import { Endpointer, FRAME_SAMPLES, frameDb, PAUSE_MS, type VadEvent, voicing, VoicingMeter } from '../vad';
import { Utterance } from '../utterance';

// The on-phone endpointer (used when Sakhi talks on the phone, not over a
// live connection) and the answer buffer it fills.

const ROOM = -62; // quiet room, dBFS
const VOICE = -28;

/** Feeds frames like the engine does: it stops at the first 'end' / 'noSpeech'. */
function run(vad: Endpointer, levels: number[]) {
  const events: { i: number; e: VadEvent }[] = [];
  for (let i = 0; i < levels.length; i++) {
    const e = vad.push(levels[i]);
    if (e === 'none' || e === 'pause') continue; // 'pause' has its own tests
    events.push({ i, e });
    if (e === 'end' || e === 'noSpeech') break;
  }
  return events;
}
const frames = (db: number, n: number) => Array<number>(n).fill(db);

describe('frameDb', () => {
  it('silence is -100 dB; full scale is ~0 dB', () => {
    expect(frameDb(new Int16Array(320), 0, 320)).toBe(-100);
    expect(frameDb(new Int16Array(320).fill(32767), 0, 320)).toBeCloseTo(0, 0);
  });
});

describe('Endpointer', () => {
  it('REGRESSION: she speaks from the very first frame: her voice never becomes the "noise floor"', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 500 });
    const ev = run(vad, [...frames(-30, 40), ...frames(ROOM, 60)]);
    expect(vad.floorDb).toBeLessThanOrEqual(-48);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
  });

  it('a quiet budget-tablet mic (-55 dBFS voice over a -66 dBFS room) is still heard', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 500 });
    expect(run(vad, [...frames(-66, 20), ...frames(-55, 30), ...frames(-66, 60)]).map((x) => x.e)).toEqual(['start', 'end']);
  });

  it('learns the room, starts on voice, ends after the hangover', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 600 });
    const ev = run(vad, [...frames(ROOM, 20), ...frames(VOICE, 40), ...frames(ROOM, 60)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
    expect(ev[0].i).toBe(22); // 3 loud frames in a row
    // hangover 600 ms + up to 300 ms extra for 0.8 s of speech
    const quietFrames = ev[1].i - 59;
    expect(quietFrames * 20).toBeGreaterThanOrEqual(600);
    expect(quietFrames * 20).toBeLessThanOrEqual(900);
  });

  it('a short pause inside one answer does not end it', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 800 });
    const ev = run(vad, [...frames(ROOM, 20), ...frames(VOICE, 30), ...frames(ROOM, 20), ...frames(VOICE, 30), ...frames(ROOM, 80)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
  });

  it('a click (1-2 loud frames) is not speech', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 600, noSpeechMs: 2000 });
    const ev = run(vad, [...frames(ROOM, 20), VOICE, VOICE, ...frames(ROOM, 100)]);
    expect(ev.map((x) => x.e)).toEqual(['noSpeech']);
  });

  it('exact digital silence (a mic still starting) is never taught as the room', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 600 });
    run(vad, frames(-100, 50));
    expect(vad.floorDb).toBe(-60); // untouched default
    const ev = run(vad, [...frames(ROOM, 20), ...frames(VOICE, 10)]);
    expect(ev.map((x) => x.e)).toEqual(['start']);
  });

  it('caps a very long answer', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 600, maxSpeechMs: 2000 });
    const ev = run(vad, [...frames(ROOM, 20), ...frames(VOICE, 200)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
    expect(ev[1].i - ev[0].i).toBeLessThanOrEqual(100);
  });

  it('REGRESSION: a soft voice just under the start threshold never raises the floor (she is not made deaf to)', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 500, noSpeechMs: 60000 });
    // A quiet room, then 4 s of murmuring 5 dB above it (not yet a turn).
    run(vad, [...frames(ROOM, 20), ...frames(ROOM + 5, 200)]);
    expect(vad.floorDb).toBeLessThanOrEqual(ROOM + 1);
    // When she speaks up a little (8 dB over the room) she is heard.
    const ev = run(vad, [...frames(ROOM + 8, 20), ...frames(ROOM, 60)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
  });

  it('REGRESSION: a noisy room (TV 6 dB over the floor) does not keep her turn open until the 20 s cap', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 600 });
    const TV = -44;
    // Calibrated in a quiet moment, then she answers loudly over the TV, then only the TV.
    const ev = run(vad, [...frames(-52, 20), ...frames(-24, 60), ...frames(TV, 300)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
    expect((ev[1].i - 80) * 20).toBeLessThanOrEqual(1200); // ends within the hangover, not at 20 s
  });

  it('a pause between words in a noisy room still does not end the answer', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 800 });
    const ev = run(vad, [...frames(-52, 20), ...frames(-24, 30), ...frames(-44, 20), ...frames(-25, 30), ...frames(-44, 80)]);
    expect(ev.map((x) => x.e)).toEqual(['start', 'end']);
    expect(ev[1].i).toBeGreaterThan(100);
  });
});

// ---- voicing: a voice is periodic, noise is not ------------------------------------
/** Deterministic noise (LCG), so a failing test fails the same way every run. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
/** One 20 ms frame: a vowel-like voice (pitch f0, 4 harmonics) at `voiceDb` plus noise at `noiseDb` (dBFS). */
function mix(n: number, f0: number, voiceDb: number | null, noiseDb: number | null, rand: () => number, colour = 0.6) {
  const out = new Int16Array(FRAME_SAMPLES);
  const va = voiceDb === null ? 0 : 32768 * 10 ** (voiceDb / 20) * Math.SQRT2 / 1.25;
  const na = noiseDb === null ? 0 : 32768 * 10 ** (noiseDb / 20) * 1.9;
  let lp = 0;
  for (let k = 0; k < FRAME_SAMPLES; k++) {
    const t = (n * FRAME_SAMPLES + k) / 16000;
    const v = Math.sin(2 * Math.PI * f0 * t) + 0.6 * Math.sin(4 * Math.PI * f0 * t) + 0.4 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t);
    lp = colour * lp + (1 - colour) * rand(); // room noise: more energy low (fan, traffic)
    out[k] = Math.max(-32768, Math.min(32767, Math.round((va * v) / 1.6 + na * lp)));
  }
  return out;
}
/** Runs frames through the VAD the way the engine does (level + voicing). */
function runPcm(vad: Endpointer, frames: Int16Array[]) {
  const events: { i: number; e: VadEvent }[] = [];
  const meter = new VoicingMeter();
  for (let i = 0; i < frames.length; i++) {
    const e = vad.push(frameDb(frames[i], 0, FRAME_SAMPLES), meter.push(frames[i], 0));
    if (e === 'none') continue;
    events.push({ i, e });
    if (e === 'end' || e === 'noSpeech') break;
  }
  return events;
}
function scene(parts: [number, number | null, number | null][], seed = 1, f0 = 210) {
  const rand = rng(seed);
  const out: Int16Array[] = [];
  for (const [n, voiceDb, noiseDb] of parts) for (let k = 0; k < n; k++) out.push(mix(out.length, f0, voiceDb, noiseDb, rand));
  return out;
}

describe('voicing', () => {
  it('a voice (women: 160-300 Hz, men: 100-150 Hz) is periodic; room noise and silence are not', () => {
    const rand = rng(7);
    for (const f0 of [110, 160, 210, 290]) expect(voicing(mix(3, f0, -30, null, rand), 0)).toBeGreaterThan(0.45);
    for (let k = 0; k < 20; k++) expect(voicing(mix(k, 200, null, -30, rand), 0)).toBeLessThan(0.4);
    expect(voicing(new Int16Array(FRAME_SAMPLES), 0)).toBe(0);
  });

  it('her voice stays voiced under room noise at 0 dB SNR', () => {
    const rand = rng(3);
    let voiced = 0;
    for (let k = 0; k < 20; k++) if (voicing(mix(k, 220, -30, -30, rand), 0) >= 0.4) voiced++;
    expect(voiced).toBeGreaterThanOrEqual(12); // real answers: 63-77 % of voice frames at 0 dB
  });
});

describe('Endpointer with voicing (the field: loud rooms, soft voices)', () => {
  it('HEAVY NOISE: a loud fan / traffic room (-30 dBFS) is never taken for speech, and her voice at the same level is caught', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 550, noSpeechMs: 60_000 });
    // 3 s of loud noise alone, then she answers at 0 dB SNR for 1 s, then noise again
    const ev = runPcm(vad, scene([[150, null, -30], [50, -30, -30], [80, null, -30]]));
    expect(ev[0]).toEqual({ i: expect.any(Number), e: 'start' });
    expect(ev[0].i).toBeGreaterThanOrEqual(150); // nothing before she spoke
    expect(ev[0].i).toBeLessThanOrEqual(150 + 6); // caught within ~120 ms
    const end = ev.find((x) => x.e === 'end')!;
    expect(end.i).toBeLessThan(200 + 50); // ends when SHE stops, not at the cap
    expect(vad.floorDb).toBeGreaterThan(-36); // the floor followed the loud room
  });

  it('the noise starts louder mid-turn wait (a pressure cooker, a bus): still not speech', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 550, noSpeechMs: 4000 });
    const ev = runPcm(vad, scene([[60, null, -60], [200, null, -28]]));
    expect(ev.map((x) => x.e)).toEqual(['noSpeech']);
  });

  it('NO SHOUTING: a soft voice only 4 dB over a quiet room starts a turn', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 550 });
    const ev = runPcm(vad, scene([[30, null, -58], [40, -55, -58], [60, null, -58]]));
    expect(ev.map((x) => x.e)).toEqual(['start', 'pause', 'end']);
  });

  it('TWO SPEAKERS: the mother 1-1.5 m away (15 dB under the ASHA) keeps the turn open after the ASHA speaks', () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 550 });
    // the ASHA prompts close to the phone (-20), then the mother answers from across (-35) for 1.5 s
    const ev = runPcm(vad, scene([[20, null, -62], [30, -20, -62], [75, -35, -62], [60, null, -62]]));
    expect(ev[0].e).toBe('start');
    const end = ev.find((x) => x.e === 'end')!;
    expect(end.i).toBeGreaterThanOrEqual(20 + 30 + 75); // not cut while the mother talks
  });

  it("'pause' comes once, 300 ms into her silence, before the end of the turn; talking again re-arms it", () => {
    const vad = new Endpointer();
    vad.reset({ hangoverMs: 800 });
    const ev = runPcm(vad, scene([[20, null, -60], [30, -28, -60], [20, null, -60], [30, -28, -60], [70, null, -60]]));
    expect(ev.map((x) => x.e)).toEqual(['start', 'pause', 'pause', 'end']);
    const firstPause = ev[1].i - 50 + 1; // quiet frames up to and including the pause
    expect(firstPause * 20).toBeGreaterThanOrEqual(PAUSE_MS);
    expect(firstPause * 20).toBeLessThanOrEqual(PAUSE_MS + 40);
    expect(vad.voicedFrames).toBeGreaterThanOrEqual(55);
  });
});

describe('Utterance', () => {
  const frame = (v: number) => new Int16Array(FRAME_SAMPLES).fill(v);

  it('keeps 300 ms of pre-roll so the first syllable is never cut', () => {
    const u = new Utterance();
    for (let i = 0; i < 30; i++) u.frame(frame(1), 0); // 600 ms before speech
    u.begin();
    u.frame(frame(2), 0);
    expect(u.durationMs).toBe(320); // 15 pre-roll frames + 1
  });

  it('writes a valid 16 kHz mono PCM16 WAV', () => {
    const u = new Utterance();
    u.begin();
    for (let i = 0; i < 50; i++) u.frame(frame(1000), 0);
    const wav = u.toWav();
    const v = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(40, true)).toBe(50 * FRAME_SAMPLES * 2);
    expect(wav.byteLength).toBe(44 + 50 * FRAME_SAMPLES * 2);
  });

  it('cuts the trailing hangover silence to 200 ms and raises a quiet answer (never clips)', () => {
    const u = new Utterance();
    u.begin();
    for (let i = 0; i < 40; i++) u.frame(frame(1500), 0); // 0.8 s of a quiet voice (-27 dBFS)
    for (let i = 0; i < 50; i++) u.frame(frame(2), 0); // 1 s of the hangover's silence
    const wav = u.toWav();
    const v = new DataView(wav.buffer);
    expect(v.getUint32(40, true)).toBe((40 + 10) * FRAME_SAMPLES * 2);
    expect(v.getInt16(44, true)).toBe(6000); // x4 (+12 dB), the cap
    const loud = new Utterance();
    loud.begin();
    for (let i = 0; i < 20; i++) loud.frame(frame(30000), 0);
    expect(new DataView(loud.toWav().buffer).getInt16(44, true)).toBe(30000);
  });

  it('uploads IMA-ADPCM: a quarter of the bytes, decoding back to the same answer', () => {
    const u = new Utterance();
    u.begin();
    // 1.2 s of a voiced, quiet tone (220 Hz + 1.1 kHz at -24 dBFS), so the raise is applied too
    for (let f = 0; f < 60; f++) {
      const fr = new Int16Array(FRAME_SAMPLES);
      for (let k = 0; k < FRAME_SAMPLES; k++) {
        const t = (f * FRAME_SAMPLES + k) / 16000;
        fr[k] = Math.round(1300 * Math.sin(2 * Math.PI * 220 * t) + 700 * Math.sin(2 * Math.PI * 1100 * t));
      }
      u.frame(fr, 0);
    }
    const pcm = u.toWav();
    const up = u.toUpload();
    const v = new DataView(up.buffer);
    const ascii = (o: number) => String.fromCharCode(...up.slice(o, o + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(up.byteLength - 8);
    expect(v.getUint16(20, true)).toBe(0x11);
    expect(v.getUint16(32, true)).toBe(256);
    expect(v.getUint16(38, true)).toBe(505);
    expect(ascii(40)).toBe('data');
    expect(up.byteLength).toBeLessThan(pcm.byteLength / 3.5);

    // decode (the gateway's algorithm) and compare with the PCM body
    const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
    const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
    const dec: number[] = [];
    for (let o = 48; o + 256 <= up.byteLength; o += 256) {
      let pred = v.getInt16(o, true);
      let idx = up[o + 2];
      dec.push(pred);
      for (let b = o + 4; b < o + 256; b++) {
        for (const nib of [up[b] & 15, up[b] >> 4]) {
          const step = STEP[idx];
          let d = step >> 3;
          if (nib & 4) d += step;
          if (nib & 2) d += step >> 1;
          if (nib & 1) d += step >> 2;
          pred = Math.max(-32768, Math.min(32767, nib & 8 ? pred - d : pred + d));
          idx = Math.max(0, Math.min(88, idx + IDX[nib]));
          dec.push(pred);
        }
      }
    }
    const pv = new DataView(pcm.buffer);
    const n = (pcm.byteLength - 44) / 2;
    let sig = 0;
    let err = 0;
    for (let i = 0; i < n; i++) {
      const x = pv.getInt16(44 + i * 2, true);
      sig += x * x;
      err += (x - dec[i]) ** 2;
    }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(20); // > 20 dB SNR: clean for a recogniser
  });

  it('never grows past 20 s (fixed buffer, no allocation per turn)', () => {
    const u = new Utterance();
    u.begin();
    for (let i = 0; i < 1200; i++) u.frame(frame(1), 0); // 24 s
    expect(u.durationMs).toBe(20000);
  });
});
