// Endpointing: an adaptive VAD over 20 ms frames of 16 kHz PCM16, on energy
// AND voicing. Decides, with no network, when the ASHA has finished
// answering, so Sakhi can ask the next question (docs/VOICE_IN_APP_DESIGN.md 4.2).
//
// VOICING (VoicingMeter, per frame): a human voice is periodic (the vocal
// folds, 90-500 Hz: her vowels); fans, traffic, rain, pressure cookers and
// hiss are not. See VoicingMeter for the measure and its field numbers.
//
// With voicing (push(db, voicing)), the rules that matter in the field:
//   * a VOICED frame starts speech at only floor + 3 dB: a normal (or soft)
//     voice is caught, nobody has to shout
//   * in a NOISY room (floor above -45 dBFS) an unvoiced frame never starts
//     speech, however loud: the fan is not her answer
//   * unvoiced frames teach the noise floor at any level (up to -20 dBFS), so
//     the floor follows a loud room instead of sticking at -38 and calling
//     the noise speech; a voice (voiced) never raises it
//   * 'pause' is emitted once when she has been quiet 200 ms in a turn: the
//     engine sends what she said so far to the recogniser THEN, while the
//     hangover still runs (speculative transcription, see engine.ts)
// push(db) alone (no voicing) keeps the energy-only rules below.
//
//   noise floor  calibrated on the first 200 ms from QUIET frames only (a
//                frame above -50 dBFS is her voice, not the room: it never
//                lifts the floor), calibrated floor at most -48 dBFS; then it
//                follows CLEARLY quiet frames only (below floor + 4 dB),
//                falling fast and rising slowly, clamped to [-75, -38] dBFS
//   start        3 frames in a row above floor + 6 dB (and above -62 dBFS:
//                budget tablets' mics are quiet)
//   stay         above floor + 4 dB AND within 12 dB of her own speech level
//                (hysteresis: harder to start than stay)
//   end          quiet for hangover = base + min(200, 0.05 * speech ms)
//   no answer    nothing in noSpeechMs -> 'noSpeech'
//   cap          maxSpeechMs of speech -> 'end'
// O(1) per frame and no allocation per frame.
//
// Two field bugs this design closes (both seen as "Sakhi keeps listening and
// nothing is saved"):
//   * a SOFT voice: frames just under the start threshold used to teach the
//     floor, so a quiet speaker raised the floor with her own voice until she
//     could never start a turn. Now only clearly quiet frames teach it, and
//     the floor rises at a fifth of the speed it falls.
//   * a NOISY room (TV, children): steady noise above floor + 4 dB kept the
//     turn "speaking" until the 20 s cap. Now a frame 12 dB under her own
//     speech level also counts as quiet, so the turn ends when she stops.

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320

export type VadEvent = 'none' | 'start' | 'pause' | 'end' | 'noSpeech';

export type VadOptions = {
  /** Base silence (ms) that ends a turn: shorter for yes/no, longer for descriptions. */
  hangoverMs: number;
  noSpeechMs?: number;
  maxSpeechMs?: number;
};

const FLOOR_MIN = -75;
const FLOOR_MAX = -38;
/** With voicing, the floor may follow a loud room this far up (a voice can still be told from it). */
const FLOOR_MAX_VOICING = -20;
/** Above this floor the room is noisy: only a voiced frame may start speech. */
const NOISY_FLOOR = -45;
const VOICED = 0.4;
/** Below this a frame is the room's noise (it may teach the floor). */
const UNVOICED = 0.3;
/** A voiced frame starts speech at only this much over the floor. */
const START_DB_VOICED = 3;
/** Quiet this long inside a turn: 'pause' (send what she said so far to the recogniser). */
export const PAUSE_MS = 200;
const START_DB = 6;
const STAY_DB = 4;
/** A frame this far under her own (smoothed) speech level is a pause, whatever the room. */
const BELOW_SPEECH_DB = 12;
/**
 * Two speakers, one phone: the ASHA close to it (~-20 dBFS), the mother 1-1.5 m
 * away (~-35 dBFS). After the ASHA speaks, the level tracker sits at HER level;
 * the mother's VOICED frames still count as speech down to 24 dB under it.
 * Unvoiced frames keep the 12 dB rule, so steady noise (a TV 6 dB over the
 * floor) still cannot hold a turn open.
 */
const BELOW_SPEECH_DB_VOICED = 24;
/** Floor learning: falls fast (the room got quieter), rises slowly (never chases a voice). */
const FLOOR_FALL = 0.1;
const FLOOR_RISE = 0.02;
/** Unvoiced (noise) frames above the floor: the room got louder, follow it (~1 s). */
const FLOOR_RISE_NOISE = 0.05;
const START_FRAMES = 3;
const ABS_MIN_DB = -62;
const CALIBRATE_FRAMES = 10; // 200 ms
/** A calibration frame louder than this is speech, not the room. */
const CALIB_SPEECH_DB = -50;
/** The calibrated floor never starts above this (she may talk from the first frame). */
const CALIB_FLOOR_MAX = -48;
/** Exact zeros (a mic that is still starting): not the room, never taught to the floor. */
const DIGITAL_SILENCE_DB = -90;

/** dBFS of `n` samples of `pcm` from `offset` (int16). Silence -> -100. */
export function frameDb(pcm: Int16Array, offset: number, n: number) {
  let sum = 0;
  for (let i = offset, end = offset + n; i < end; i++) {
    const s = pcm[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

// ---- voicing ---------------------------------------------------------------------
const DEC = 4; // 16 kHz -> 4 kHz: a voice's pitch and first harmonics, not the hiss above
const HALF = FRAME_SAMPLES / DEC; // 80 samples per 20 ms frame
const WIN = HALF * 2; // 40 ms window: this frame and the one before (two pitch periods at 90 Hz)
const LAG_MIN = 8; // 500 Hz
const LAG_MAX = 44; // 90 Hz
/** A peak must rise this far above the lowest correlation before it to count. */
const PROMINENCE = 0.3;

/**
 * Voicing meter: 0..1, how periodic (voice-like) the last 40 ms are.
 *
 * Normalised autocorrelation at 4 kHz after a gentle low-pass and a strong
 * rumble cut, scored by PEAK PROMINENCE: a voice gives a clear peak at its
 * pitch period with a dip before it; low-frequency noise (fan, traffic,
 * rumble) correlates with itself at every lag but has no such peak. Tuned on
 * the STT test set's real answers under white / fan / rumble / traffic noise:
 * noise read as voice 0-4 %; voice frames caught 82-91 % at 5-10 dB SNR,
 * 63-77 % at 0 dB (scratch voicing_proto.py). ~20k multiply-adds per frame,
 * no allocation.
 */
export class VoicingMeter {
  private readonly x = new Float32Array(WIN);
  private readonly r = new Float32Array(LAG_MAX + 2);

  reset() {
    this.x.fill(0);
  }

  /** Feed one 20 ms frame (FRAME_SAMPLES at 16 kHz); returns its voicing. */
  push(pcm: Int16Array, offset: number): number {
    const x = this.x;
    x.copyWithin(0, HALF); // keep the previous frame
    for (let i = 0; i < HALF; i++) {
      const o = offset + i * DEC;
      x[HALF + i] = (pcm[o] + pcm[o + 1] + pcm[o + 2] + pcm[o + 3]) * 0.25;
    }
    return score(x, this.r);
  }
}

const z = new Float32Array(WIN);

function score(x: Float32Array, r: Float32Array): number {
  // low-pass (one pole), DC out, rumble cut (z = y - 0.9 y[-1])
  let acc = 0;
  let mean = 0;
  for (let i = 0; i < WIN; i++) {
    acc = 0.5 * acc + 0.5 * x[i];
    z[i] = acc;
    mean += acc;
  }
  mean /= WIN;
  let prev = 0;
  let energy = 0;
  for (let i = 0; i < WIN; i++) {
    const y = z[i] - mean;
    z[i] = y - 0.9 * prev;
    prev = y;
    energy += z[i] * z[i];
  }
  if (energy < WIN * 4) return 0; // silence
  for (let lag = 1; lag <= LAG_MAX + 1; lag++) {
    let num = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0, n = WIN - lag; i < n; i++) {
      const a = z[i];
      const b = z[i + lag];
      num += a * b;
      e0 += a * a;
      e1 += b * b;
    }
    r[lag] = num / Math.sqrt(e0 * e1 + 1e-9);
  }
  let best = 0;
  let low = r[1];
  for (let lag = 2; lag <= LAG_MAX; lag++) {
    if (r[lag - 1] < low) low = r[lag - 1];
    if (lag < LAG_MIN) continue;
    const v = r[lag];
    if (v > 0 && v >= r[lag - 1] && v >= r[lag + 1]) {
      const s = Math.min(v, v - low - PROMINENCE);
      if (s > best) best = s;
    }
  }
  return best;
}

/** One frame on its own (no history): for tests and one-off checks. */
export function voicing(pcm: Int16Array, offset: number): number {
  const m = new VoicingMeter();
  m.push(pcm, offset);
  return m.push(pcm, offset);
}

export class Endpointer {
  private opts: Required<VadOptions> = { hangoverMs: 500, noSpeechMs: 7000, maxSpeechMs: 20000 };
  private floor = -60;
  private calib: number[] = [];
  private calibFrames = 0;
  private above = 0;
  private speaking = false;
  private speechMs = 0;
  private quietMs = 0;
  private waitedMs = 0;
  /** Her speech level while she talks (EMA of voiced frames), dBFS. */
  private speechDb = -100;
  private voiced = 0;
  private paused = false;
  private grace = 1;
  /** 0..1, for the orb (smoothed). */
  level = 0;
  /** Loudest frame since reset (dBFS), for diagnostics. */
  peakDb = -100;

  reset(opts: VadOptions) {
    this.opts = { noSpeechMs: 7000, maxSpeechMs: 20000, ...opts };
    this.above = 0;
    this.speaking = false;
    this.speechMs = 0;
    this.quietMs = 0;
    this.waitedMs = 0;
    this.peakDb = -100;
    this.speechDb = -100;
    this.voiced = 0;
    this.paused = false;
    this.grace = 1;
    // The noise floor carries over between questions (same room); it is
    // re-calibrated only on the very first turn.
  }

  get isSpeaking() {
    return this.speaking;
  }

  get speechDurationMs() {
    return this.speechMs;
  }

  get floorDb() {
    return this.floor;
  }

  /** Voiced frames heard in this turn: grows only while she actually speaks (speculative STT checks it). */
  get voicedFrames() {
    return this.voiced;
  }

  /** Quiet so far inside this turn (ms since her last voiced frame). */
  get quietForMs() {
    return this.quietMs;
  }

  /**
   * Feed one 20 ms frame: its level (dBFS) and, when known, its voicing
   * (0..1, voicing()). Returns what happened.
   */
  push(db: number, v?: number): VadEvent {
    const known = v !== undefined;
    const hi = known ? FLOOR_MAX_VOICING : FLOOR_MAX;
    if (db > this.peakDb) this.peakDb = db;
    if (db <= DIGITAL_SILENCE_DB && !this.speaking) {
      this.waitedMs += FRAME_MS;
      return this.waitedMs >= this.opts.noSpeechMs ? 'noSpeech' : 'none';
    }
    // Level for the UI: 0 at the floor, 1 at floor + 30 dB.
    const target = Math.max(0, Math.min(1, (db - this.floor) / 30));
    this.level += (target - this.level) * 0.35;

    if (this.calibFrames < CALIBRATE_FRAMES) {
      this.calibFrames++;
      // The room: quiet frames, and with voicing ANY unvoiced frame (a loud fan is the room too).
      if (db <= CALIB_SPEECH_DB || (known && (v as number) < UNVOICED)) this.calib.push(db);
      if (this.calibFrames === CALIBRATE_FRAMES) {
        // No quiet frame at all (she spoke at once, or a loud room): start
        // from the cap; the quiet frames that follow teach the real floor.
        const sorted = [...this.calib].sort((x, y) => x - y);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : CALIB_FLOOR_MAX;
        this.floor = clamp(known ? median : Math.min(CALIB_FLOOR_MAX, median), hi);
      }
      this.waitedMs += FRAME_MS;
      return 'none';
    }

    if (!this.speaking) {
      this.waitedMs += FRAME_MS;
      if (this.starts(db, v)) {
        this.above++;
        if (this.above >= START_FRAMES) {
          this.speaking = true;
          this.speechMs = this.above * FRAME_MS;
          this.quietMs = 0;
          this.paused = false;
          this.voiced = this.above;
          this.speechDb = db;
          return 'start';
        }
      } else {
        // One odd frame inside a start (a consonant, a noise burst) does not reset it.
        this.above = known && this.above > 0 && this.grace-- > 0 ? this.above : 0;
        if (this.above === 0) this.grace = 1;
        // Teach the floor: CLEARLY quiet frames (a soft voice in the grey zone
        // floor + 4..6 dB must never raise it) and, with voicing, unvoiced
        // frames at any level (the room's noise, never her voice).
        const unvoiced = known && (v as number) < UNVOICED;
        if (db <= this.floor + STAY_DB || unvoiced) {
          const rate = db < this.floor ? FLOOR_FALL : unvoiced ? FLOOR_RISE_NOISE : FLOOR_RISE;
          this.floor = clamp(this.floor + rate * (db - this.floor), hi);
        }
        if (this.waitedMs >= this.opts.noSpeechMs) return 'noSpeech';
      }
      return 'none';
    }

    this.speechMs += FRAME_MS;
    const noisy = this.floor > NOISY_FLOOR;
    const voiced =
      db > this.floor + STAY_DB &&
      (db > this.speechDb - BELOW_SPEECH_DB || (known && (v as number) >= VOICED && db > this.speechDb - BELOW_SPEECH_DB_VOICED)) &&
      // in a noisy room a frame must sound like a voice (or be far above the room) to count
      (!known || !noisy || (v as number) >= UNVOICED || db > this.floor + 10);
    if (voiced) {
      this.quietMs = 0;
      this.paused = false;
      this.voiced++;
      // Her level follows her voice (fast up, slow down: one loud word does not deafen it).
      this.speechDb += (db > this.speechDb ? 0.3 : 0.05) * (db - this.speechDb);
    } else {
      this.quietMs += FRAME_MS;
    }
    const hangover = this.opts.hangoverMs + Math.min(200, 0.05 * this.speechMs);
    if (this.quietMs >= hangover || this.speechMs >= this.opts.maxSpeechMs) {
      this.speaking = false;
      return 'end';
    }
    if (!this.paused && this.quietMs >= PAUSE_MS) {
      this.paused = true;
      return 'pause';
    }
    return 'none';
  }

  /** Can this frame (help) start speech? */
  private starts(db: number, v?: number) {
    if (db <= ABS_MIN_DB) return false;
    if (v === undefined) return db > this.floor + START_DB;
    if (v >= VOICED && db > this.floor + START_DB_VOICED) return true;
    // a quiet room: a clearly loud, somewhat periodic frame (a breathy start) also counts
    return this.floor <= NOISY_FLOOR && v >= UNVOICED && db > this.floor + START_DB;
  }
}

const clamp = (v: number, hi = FLOOR_MAX) => Math.max(FLOOR_MIN, Math.min(hi, v));
