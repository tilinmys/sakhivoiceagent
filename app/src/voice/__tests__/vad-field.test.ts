/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { Endpointer, FRAME_SAMPLES, frameDb, type VadEvent, VoicingMeter } from '../vad';

// Field evaluation of the endpointer on the STT test set's REAL answers
// (scripts/stt_eval/audio, kept locally, not in git: skipped without them).
// Each answer gets 1.5 s of room before and 1.5 s after, under: a quiet
// room, a soft voice, fan / traffic noise at 5 and 0 dB SNR. Reports, for
// energy-only vs energy + voicing: answers caught, false starts on the
// noise before she spoke, start delay, and how long after she stopped the
// turn ended (that delay is latency she feels).

const DIR = path.resolve(__dirname, '../../../../scripts/stt_eval/audio');
// Opt-in (about 2 min): SAKHI_FIELD=1 npx jest vad-field
const have = fs.existsSync(DIR) && !!process.env.SAKHI_FIELD;

function readWav(file: string): Int16Array {
  const b = fs.readFileSync(file);
  let pos = 12;
  let data: Buffer | null = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'data') data = b.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  const d = data as Buffer;
  return new Int16Array(d.buffer.slice(d.byteOffset, d.byteOffset + (d.length & ~1)));
}

function rng(seed: number) {
  let x = seed >>> 0;
  const u = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return () => (u() + u() + u() + u() - 2) * 1.73; // ~N(0,1)
}

function noise(kind: 'fan' | 'traffic', n: number, seed: number) {
  const r = rng(seed);
  const out = new Float32Array(n);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    if (kind === 'fan') {
      a = 0.6 * a + 0.4 * r();
      out[i] = a;
    } else {
      a = 0.97 * a + 0.03 * r(); // rumble
      b = 0.5 * b + 0.5 * r();
      out[i] = (a * 6 + b * 0.5) * (1 + 0.8 * Math.sin((2 * Math.PI * 0.7 * i) / 16000));
    }
  }
  return out;
}

type Cond = { name: string; gainDb: number; noise?: 'fan' | 'traffic'; snr?: number };
const CONDS: Cond[] = [
  { name: 'quiet room', gainDb: 0 },
  { name: 'soft voice (-24 dB)', gainDb: -24 },
  { name: 'fan 5 dB SNR', gainDb: 0, noise: 'fan', snr: 5 },
  { name: 'fan 0 dB SNR', gainDb: 0, noise: 'fan', snr: 0 },
  { name: 'traffic 5 dB SNR', gainDb: 0, noise: 'traffic', snr: 5 },
  { name: 'traffic 0 dB SNR', gainDb: 0, noise: 'traffic', snr: 0 },
];

function scenario(clip: Int16Array, c: Cond, seed: number) {
  const lead = 75; // frames: 1.5 s
  const tail = 75;
  const frames = Math.floor(clip.length / FRAME_SAMPLES);
  const n = (lead + frames + tail) * FRAME_SAMPLES;
  const x = new Float32Array(n);
  const g = 10 ** (c.gainDb / 20);
  for (let i = 0; i < frames * FRAME_SAMPLES; i++) x[lead * FRAME_SAMPLES + i] = clip[i] * g;
  // truth: frames within 20 dB of the loudest
  const db: number[] = [];
  for (let f = 0; f < frames; f++) db.push(frameDb(clip, f * FRAME_SAMPLES, FRAME_SAMPLES));
  const top = Math.max(...db);
  const on = db.map((d) => d > top - 20);
  const first = lead + on.indexOf(true);
  const last = lead + on.lastIndexOf(true);
  let p = 0;
  let k = 0;
  db.forEach((d, f) => {
    if (on[f]) {
      for (let i = 0; i < FRAME_SAMPLES; i++) p += (clip[f * FRAME_SAMPLES + i] * g) ** 2;
      k += FRAME_SAMPLES;
    }
  });
  if (c.noise) {
    const nz = noise(c.noise, n, seed);
    let pn = 0;
    for (let i = 0; i < n; i++) pn += nz[i] * nz[i];
    const scale = Math.sqrt(p / k / 10 ** ((c.snr as number) / 10) / (pn / n));
    for (let i = 0; i < n; i++) x[i] += nz[i] * scale;
  }
  // room hiss always (a phone mic is never digitally silent)
  const h = rng(seed + 99);
  for (let i = 0; i < n; i++) x[i] += h() * 20;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i])));
  return { pcm, first, last };
}

function run(pcm: Int16Array, withVoicing: boolean) {
  const vad = new Endpointer();
  vad.reset({ hangoverMs: 550, noSpeechMs: 60_000, maxSpeechMs: 15_000 });
  const m = new VoicingMeter();
  let start = -1;
  let end = -1;
  for (let f = 0; f * FRAME_SAMPLES + FRAME_SAMPLES <= pcm.length; f++) {
    const db = frameDb(pcm, f * FRAME_SAMPLES, FRAME_SAMPLES);
    const v = m.push(pcm, f * FRAME_SAMPLES);
    const e: VadEvent = vad.push(db, withVoicing ? v : undefined);
    if (e === 'start') start = f;
    if (e === 'end') {
      end = f;
      break;
    }
  }
  return { start, end };
}

(have ? describe : describe.skip)('endpointer on real answers (field conditions)', () => {
  it('caught, false starts, start delay, end delay: energy-only vs energy + voicing', () => {
    const all = fs.readdirSync(DIR).filter((f) => /-\d\.wav$/.test(f)).sort();
    const files = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 18)) === 0); // a spread of ~18 answers, kn / hi / en
    const rows: string[] = [];
    const summary: Record<string, { caught: number; falseStart: number }> = {};
    for (const c of CONDS) {
      for (const mode of [false, true]) {
        let caught = 0;
        let falseStart = 0;
        const sd: number[] = [];
        const ed: number[] = [];
        files.forEach((f, i) => {
          const { pcm, first, last } = scenario(readWav(path.join(DIR, f)), c, i + 1);
          const r = run(pcm, mode);
          if (r.start >= 0 && r.start < first - 5) falseStart++;
          else if (r.start >= 0 && r.start <= last) {
            caught++;
            sd.push((r.start - first) * 20);
            if (r.end > 0) ed.push((r.end - last) * 20);
          }
        });
        const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
        rows.push(`${c.name.padEnd(20)} ${mode ? 'voicing' : 'energy '}  caught ${String(caught).padStart(3)}/${files.length}  false starts ${String(falseStart).padStart(3)}  start +${med(sd)} ms  end +${med(ed)} ms`);
        summary[`${c.name}|${mode}`] = { caught, falseStart };
      }
    }
    console.log(rows.join('\n'));
    // the voicing endpointer must not lose to energy-only anywhere it matters
    for (const c of CONDS) expect(summary[`${c.name}|true`].falseStart).toBeLessThanOrEqual(summary[`${c.name}|false`].falseStart);
  }, 120_000);
});
