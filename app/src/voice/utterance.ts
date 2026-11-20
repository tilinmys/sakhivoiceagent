import { FRAME_SAMPLES, SAMPLE_RATE } from './vad';

// The answer being spoken, as PCM16 in ONE preallocated buffer (20 s at
// 16 kHz = 640 KB), reused for every turn. While nobody speaks, frames go
// to a 300 ms pre-roll ring; when speech starts the ring is copied in first
// so the first syllable is never cut. `toUpload()` makes the upload body
// (IMA-ADPCM, 4x smaller), `toWav()` the same answer as plain PCM16.

const MAX_SECONDS = 20;
const PREROLL_FRAMES = 15; // 300 ms

export class Utterance {
  private readonly buf = new Int16Array(SAMPLE_RATE * MAX_SECONDS);
  private readonly ring = new Int16Array(FRAME_SAMPLES * PREROLL_FRAMES);
  private ringHead = 0; // next frame slot
  private ringFilled = 0;
  private len = 0;
  private recording = false;

  reset() {
    this.len = 0;
    this.ringHead = 0;
    this.ringFilled = 0;
    this.recording = false;
  }

  /** Speech started: move the pre-roll in, then keep appending. */
  begin() {
    this.len = 0;
    const frames = this.ringFilled;
    for (let k = 0; k < frames; k++) {
      const slot = (this.ringHead - frames + k + PREROLL_FRAMES) % PREROLL_FRAMES;
      this.append(this.ring, slot * FRAME_SAMPLES, FRAME_SAMPLES);
    }
    this.recording = true;
  }

  /** End of turn: nothing more is appended until the next begin(). */
  end() {
    this.recording = false;
    this.ringHead = 0;
    this.ringFilled = 0;
  }

  /** One 20 ms frame (a view into the mic buffer; copied, never kept). */
  frame(pcm: Int16Array, offset: number) {
    if (this.recording) {
      this.append(pcm, offset, FRAME_SAMPLES);
      return;
    }
    this.ring.set(pcm.subarray(offset, offset + FRAME_SAMPLES), this.ringHead * FRAME_SAMPLES);
    this.ringHead = (this.ringHead + 1) % PREROLL_FRAMES;
    this.ringFilled = Math.min(PREROLL_FRAMES, this.ringFilled + 1);
  }

  /** The answer so far (pre-roll included): a view, valid until the next reset. */
  view(): Int16Array {
    return this.buf.subarray(0, this.len);
  }

  get durationMs() {
    return Math.round((this.len / SAMPLE_RATE) * 1000);
  }

  private append(src: Int16Array, offset: number, n: number) {
    const room = this.buf.length - this.len;
    const take = Math.min(room, n);
    if (take <= 0) return;
    this.buf.set(src.subarray(offset, offset + take), this.len);
    this.len += take;
  }

  /**
   * WAV (RIFF, PCM16 mono 16 kHz): 44-byte header + the samples, made ready
   * for the recogniser:
   *   * the trailing silence the endpointer waited through (its hangover,
   *     0.5-1.2 s) is cut down to 200 ms: less to upload and to decode
   *   * a quiet answer (phone on the table, a soft voice) is raised to a
   *     -3 dBFS peak, at most +12 dB: the model hears soft speech far
   *     better at a normal level. Loud audio is never touched (no clipping).
   */
  toWav(): Uint8Array {
    const { len, gain } = this.prepared();
    const bytes = len * 2;
    const out = new Uint8Array(44 + bytes);
    const v = new DataView(out.buffer);
    riff(out, v, 36 + bytes, 16);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    ascii(out, 36, 'data');
    v.setUint32(40, bytes, true);
    if (gain > 1.05) {
      for (let i = 0; i < len; i++) v.setInt16(44 + i * 2, Math.round(this.buf[i] * gain), true);
    } else {
      out.set(new Uint8Array(this.buf.buffer, this.buf.byteOffset, bytes), 44);
    }
    return out;
  }

  /**
   * The upload body: the same answer as toWav() (trimmed, quiet voices
   * raised), as 4-bit IMA-ADPCM (WAV format 0x11): a QUARTER of the bytes
   * (a 5 s answer: ~40 KB instead of 160 KB), which on a 2G / weak 4G link
   * is the difference between 1 s and 4 s of upload. Measured on the STT
   * test set: Gnani's error rate is identical to PCM16 (0.174 both). The
   * gateway (sakhi_audio.decode) turns it back into PCM16. One O(n) pass,
   * no allocation besides the output.
   */
  toUpload(): Uint8Array {
    // Field A/B switch: EXPO_PUBLIC_SAKHI_UPLOAD=pcm16 sends plain PCM16 (4x the bytes).
    if (UPLOAD_PCM16) return this.toWav();
    const { len, gain } = this.prepared();
    const blocks = Math.max(1, Math.ceil(len / ADPCM_SPB));
    const bytes = blocks * ADPCM_BLOCK;
    const out = new Uint8Array(48 + bytes);
    const v = new DataView(out.buffer);
    riff(out, v, 40 + bytes, 20);
    v.setUint16(20, 0x11, true); // IMA-ADPCM
    v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, Math.round((SAMPLE_RATE * ADPCM_BLOCK) / ADPCM_SPB), true);
    v.setUint16(32, ADPCM_BLOCK, true);
    v.setUint16(34, 4, true);
    v.setUint16(36, 2, true); // extra bytes
    v.setUint16(38, ADPCM_SPB, true);
    ascii(out, 40, 'data');
    v.setUint32(44, bytes, true);
    const sample = (i: number) => {
      if (i >= len) return 0;
      const x = gain > 1.05 ? Math.round(this.buf[i] * gain) : this.buf[i];
      return x > 32767 ? 32767 : x < -32768 ? -32768 : x;
    };
    let idx = 0;
    for (let b = 0; b < blocks; b++) {
      const o = 48 + b * ADPCM_BLOCK;
      const first = b * ADPCM_SPB;
      let pred = sample(first);
      v.setInt16(o, pred, true);
      out[o + 2] = idx;
      out[o + 3] = 0;
      for (let k = 1; k < ADPCM_SPB; k++) {
        const step = STEP[idx];
        let diff = sample(first + k) - pred;
        let nib = 0;
        if (diff < 0) {
          nib = 8;
          diff = -diff;
        }
        let d = step >> 3;
        if (diff >= step) {
          nib |= 4;
          diff -= step;
          d += step;
        }
        if (diff >= step >> 1) {
          nib |= 2;
          diff -= step >> 1;
          d += step >> 1;
        }
        if (diff >= step >> 2) {
          nib |= 1;
          d += step >> 2;
        }
        pred = nib & 8 ? pred - d : pred + d;
        pred = pred > 32767 ? 32767 : pred < -32768 ? -32768 : pred;
        idx += INDEX[nib];
        idx = idx < 0 ? 0 : idx > 88 ? 88 : idx;
        // samples 1,2 -> byte 4 (low, high nibble), 3,4 -> byte 5, ...
        const at = o + 4 + ((k - 1) >> 1);
        out[at] = (k - 1) & 1 ? out[at] | (nib << 4) : nib;
      }
    }
    return out;
  }

  /** What both bodies share: the length after the trim, and the gain for a quiet voice. */
  private prepared(): { len: number; gain: number } {
    const len = this.speechEnd();
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(this.buf[i]);
      if (a > peak) peak = a;
    }
    return { len, gain: peak > 0 ? Math.min(MAX_GAIN, TARGET_PEAK / peak) : 1 };
  }

  /** Samples up to 200 ms after the last frame within 35 dB of the loudest one. */
  private speechEnd(): number {
    const frames = Math.floor(this.len / FRAME_SAMPLES);
    if (frames <= TAIL_FRAMES) return this.len;
    const energy = (f: number) => {
      let sum = 0;
      for (let i = f * FRAME_SAMPLES, end = i + FRAME_SAMPLES; i < end; i++) sum += this.buf[i] * this.buf[i];
      return sum / FRAME_SAMPLES;
    };
    let loudest = 0;
    for (let f = 0; f < frames; f++) loudest = Math.max(loudest, energy(f));
    if (loudest === 0) return this.len;
    const quiet = loudest * QUIET_RATIO;
    let last = frames - 1;
    while (last > 0 && energy(last) < quiet) last--;
    return Math.min(this.len, (last + 1 + TAIL_FRAMES) * FRAME_SAMPLES);
  }
}

/** Peak a quiet answer is raised to (-3 dBFS), and the most it may be raised (+12 dB). */
const TARGET_PEAK = Math.round(32767 * 0.708);
const MAX_GAIN = 4;
/** Trailing frames kept after her last voiced frame (200 ms). */
const TAIL_FRAMES = 10;
/** -35 dB in energy: a frame quieter than this, relative to the loudest, is silence. */
const QUIET_RATIO = 10 ** (-35 / 10);

/** Upload format: IMA-ADPCM unless EXPO_PUBLIC_SAKHI_UPLOAD=pcm16 (same Gnani accuracy measured, 4x smaller). */
const UPLOAD_PCM16 = (process.env.EXPO_PUBLIC_SAKHI_UPLOAD ?? '').toLowerCase() === 'pcm16';

/** IMA-ADPCM: 256-byte blocks (4-byte header + 252 bytes of nibbles) = 505 samples each. */
const ADPCM_BLOCK = 256;
const ADPCM_SPB = (ADPCM_BLOCK - 4) * 2 + 1;
const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function ascii(out: Uint8Array, o: number, s: string) {
  for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
}

/** RIFF / WAVE / 'fmt ' with the given sizes; the caller fills the format fields. */
function riff(out: Uint8Array, v: DataView, riffSize: number, fmtSize: number) {
  ascii(out, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  ascii(out, 8, 'WAVE');
  ascii(out, 12, 'fmt ');
  v.setUint32(16, fmtSize, true);
}
