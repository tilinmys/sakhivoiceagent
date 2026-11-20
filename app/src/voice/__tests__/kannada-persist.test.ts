import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { store } from '@/data/store';

import type { RemoteAnswer } from '../live';
import { extract } from '../nlu/extract';

// Field report: "nothing is fed". Every spoken Kannada answer must end as a
// row in the phone's answers table, with BOTH what she said (heard, the raw
// transcript) and what was understood (value), whatever the wording:
// numbers in words, romanized Kannada (howdu / illa), and a recogniser's
// one-letter slip in a clinical word.

jest.mock('../speaker', () => ({
  Speaker: class {
    checkDeviceVoice() {}
    async preloadRecorded() {}
    warm() {}
    prefetch() {
      return Promise.resolve(null);
    }
    async speak(_t: string, onStart?: () => void) {
      onStart?.();
    }
    stop() {}
    release() {}
  },
}));
jest.mock('../mic', () => ({ Mic: class {}, micSupported: false, micPermission: async () => false, playbackMode: async () => {}, unlockAudio: () => {}, AFTER_STOP_MS: 0 }));
jest.mock('../gateway', () => ({ GatewayError: class extends Error {}, gateway: { offline: false, health: async () => ({ stt: true, tts: true }), stt: jest.fn(), warm: () => {} } }));
jest.mock('../db', () => {
  const rows = new Map<string, { qid: string; value: string; heard: string | null; status: string }>();
  return {
    rows,
    voiceDb: {
      createSession: async () => {},
      endSession: async () => {},
      upsertTurn: async () => {},
      updateTurn: async () => {},
      logEvent: async () => {},
      saveAnswer: async (a: { session_id: string; qid: string; value: string; heard: string | null; status: string }) => void rows.set(`${a.session_id}#${a.qid}`, a),
      answers: async () => [],
    },
  };
});

// eslint-disable-next-line import/first
import { SakhiEngine } from '../engine';

const rows = (jest.requireMock('../db') as { rows: Map<string, { qid: string; value: string; heard: string | null; status: string }> }).rows;

/** What she said to each first-visit question (Gnani-style Kannada, some romanized). */
const SAID: Record<string, string> = {
  name: 'ನನ್ನ ಹೆಸರು ಕವಿತಾ',
  age: 'ಇಪ್ಪತ್ನಾಲ್ಕು ವರ್ಷ',
  village: 'ಕಮಠಾಣ',
  firstPregnancy: 'howdu',
  prevPregnancies: '1',
  lmp: '3 ತಿಂಗಳ ಹಿಂದೆ',
  regularPeriods: 'ಹೌದು',
  confirmed: 'ಹೌದು ಆಸ್ಪತ್ರೆಯಲ್ಲಿ',
  deliveries: '1',
  losses: 'illa',
  pastProblems: 'ಇಲ್ಲ ಏನೂ ತೊಂದರೆ ಇಲ್ಲ',
  csection: 'ಇಲ್ಲ',
  conditions: 'illa',
  longIllness: 'ಇಲ್ಲ',
  medicines: 'ಕಬ್ಬಿಣ ಮತ್ತು ಕ್ಯಾಲ್ಸಿಯಂ',
  allergy: 'ಇಲ್ಲ',
  transfusion: 'ಇಲ್ಲ',
  bleedDischarge: 'ಇಲ್ಲ',
  feverPain: 'ಜ್ವರ ಇಲ್ಲ ವಾಂತಿ ಇಲ್ಲ ಹೊಟ್ಟೆ ನೋವು ಇಲ್ಲ',
  tobacco: 'ಇಲ್ಲ',
  concerns: 'ಏನೂ ಇಲ್ಲ',
};

class Remote {
  readonly transport = 'websocket' as const;
  stop = jest.fn();
  next = jest.fn();
  async connect() {}
  async say(_t: string, onStart?: () => void) {
    onStart?.();
    return true;
  }
  constructor(private readonly reply: (text: string) => RemoteAnswer) {}
  async ask(text: string, _l: unknown, hooks: { onStart?: () => void; onListening?: () => void }) {
    hooks.onStart?.();
    hooks.onListening?.();
    await Promise.resolve();
    return this.reply(text);
  }
  onLevel() {}
  onLost() {}
}

let engines: SakhiEngine[] = [];
beforeEach(() => {
  store.resetDemo();
  rows.clear();
  engines = [];
});
afterEach(() => engines.forEach((e) => e.release()));

async function waitFor(pred: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Kannada answers are all saved to the phone (raw + understood)', () => {
  it('every spoken answer of a first visit is a row: what she said AND what was understood', async () => {
    const mother = store.get().find((m) => m.id === 'kavitha')!;
    const e = new SakhiEngine(mother, 'kn', { warm: false, visit: 1, confirmMs: 0 });
    engines.push(e);
    const { questionsFor, questionText } = jest.requireActual('@/data/mockScreening') as typeof import('@/data/mockScreening');
    const byText = new Map(questionsFor(1).map((q) => [questionText(q, 'kn'), q.id]));
    const asked: string[] = [];
    await e.start(new Remote((text) => {
      const id = byText.get(text) ?? '';
      asked.push(id);
      return { kind: 'text', text: SAID[id] ?? 'ಇಲ್ಲ', sttMs: 190 };
    }));
    await waitFor(() => e.getSnapshot().stage === 'done');
    await e.flushWrites();
    const spoken = [...new Set(asked.filter((id) => SAID[id]))];
    expect(spoken.length).toBeGreaterThanOrEqual(15);
    for (const id of spoken) {
      const row = rows.get(`${e.sessionId}#${id}`);
      expect([id, !!row]).toEqual([id, true]);
      expect([id, row!.heard]).toEqual([id, SAID[id]]); // the raw transcript, never lost
      expect([id, row!.status]).toEqual([id, 'saved']); // understood, not "unclear"
      expect(row!.value.length).toBeGreaterThan(0);
    }
    expect(rows.get(`${e.sessionId}#age`)!.value).toContain('24');
    expect(rows.get(`${e.sessionId}#firstPregnancy`)!.value.toLowerCase()).toContain('yes');
  });

  it('a one-letter recogniser slip in a Kannada clinical word is still understood; yes / no never are fuzzy', () => {
    expect(extract('ತಲೆನೊವು ಇದೆ').said.get('HEADACHE')).toBe(1); // ೊ for ೋ
    expect(extract('ರಕ್ತಸ್ರವ ಆಗಿದೆ').said.get('BLEEDING')).toBe(1); // a dropped vowel sign
    expect(extract('ಇಲ್ಲಿ').said.size).toBe(0); // "here" is not "no"
  });
});
