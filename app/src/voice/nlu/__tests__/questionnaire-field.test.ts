import { describe, expect, it } from '@jest/globals';

import { followUpText } from '../followup';
import { Intake } from '../intake';

// The questionnaire breaks seen in the field (check-in log, 2026-11-17), as
// she actually answered, and what the questionnaire must do instead:
// clarify a bare "yes" ONCE, then record what she said; never record a
// question skipped for a first pregnancy as "Not clear".

/** One turn: answer, then the follow-up (if any) the engine would ask next. */
function turn(intake: Intake, qid: string, said: string) {
  const out = intake.answer(qid, said);
  const f = intake.missing(qid);
  return { out, follow: f ? followUpText('en', f) : null };
}

describe('first pregnancy: what is skipped is recorded as such', () => {
  it('"ಹೌದು" (yes, first pregnancy): losses, past problems and C-section read "None: first pregnancy"', () => {
    const it1 = new Intake(1);
    it1.answer('firstPregnancy', 'ಹೌದು ಹೌದು');
    for (const q of ['prevPregnancies', 'deliveries', 'losses', 'pastProblems', 'csection']) {
      expect([q, it1.skippable(q)]).toEqual([q, true]);
      expect([q, it1.record(q).value]).toEqual([q, 'None: first pregnancy']);
    }
  });

  it('a C-section named under "problems in previous deliveries" fills the C-section question', () => {
    const it2 = new Intake(1);
    it2.answer('firstPregnancy', 'ಇಲ್ಲ');
    it2.answer('pastProblems', 'ಸಿಸೇರಿಯನ್ ಆಗಿತ್ತು');
    expect(it2.skippable('csection')).toBe(true);
    expect(it2.record('csection').value).toBe('Yes, C-section before (check)');
  });
});

describe('a bare "yes" to a danger question: "which one?", once', () => {
  it('"ಆಗಿದೆ ಹಾಗಿದೆ" to bleeding / discharge -> "Which one: bleeding or unusual discharge?" -> "ರಕ್ತಸ್ರಾವ" -> bleeding (danger)', () => {
    const it1 = new Intake(1);
    const a = turn(it1, 'bleedDischarge', 'ಆಗಿದೆ ಹಾಗಿದೆ');
    expect(a.out.complete).toBe(false);
    expect(a.out.record.danger).toBe(true); // flagged at once, before the clarification
    expect(a.follow).toBe('Which one: bleeding or unusual discharge?');
    const b = turn(it1, 'bleedDischarge', 'ರಕ್ತಸ್ರಾವ ಆಗಿದೆ');
    expect(b.out.complete).toBe(true);
    expect(b.out.record.signs).toEqual(['bleeding']);
    expect(b.follow).toBeNull();
  });

  it('"ಆಗಿದೆ ಆಗಿದೆ" to fever / vomiting / pain -> which -> "ಜ್ವರ" -> fever', () => {
    const it1 = new Intake(1);
    expect(turn(it1, 'feverPain', 'ಆಗಿದೆ ಆಗಿದೆ').follow).toBe('Which one: fever or severe vomiting or stomach pain?');
    expect(turn(it1, 'feverPain', 'ಜ್ವರ ಇತ್ತು').out.record.signs).toEqual(['fever']);
  });

  it('still no sign named after the clarification: recorded as a flagged "yes", and the questionnaire goes on', () => {
    const it1 = new Intake(1);
    turn(it1, 'bleedDischarge', 'ಆಗಿದೆ');
    const b = turn(it1, 'bleedDischarge', 'ಹೌದು ಆಗಿದೆ');
    expect(b.out.complete).toBe(true);
    expect(b.out.record).toMatchObject({ value: 'Yes (sign not named: check)', danger: true });
  });

  it('clarified as "none of these": No, and no flag', () => {
    const it1 = new Intake(1);
    turn(it1, 'bleedDischarge', 'ಆಗಿದೆ');
    const b = turn(it1, 'bleedDischarge', 'ಇಲ್ಲ ಯಾವುದೂ ಇಲ್ಲ');
    expect(b.out.complete).toBe(true);
    expect(b.out.record).toEqual({ value: 'No', danger: false });
  });
});

describe('a bare "yes" to a list or open question: one clarifying question, then her words', () => {
  it('medicines "ತೆಗೆದ್ಕೊತಿದ್ದೀನಿ ಹೌದು" -> "Which ones?" -> "ಕಬ್ಬಿಣ ಮಾತ್ರೆ" -> Iron', () => {
    const it1 = new Intake(1);
    const a = turn(it1, 'medicines', 'ತೆಗೆದ್ಕೊತಿದ್ದೀನಿ ಹೌದು');
    expect(a.out.complete).toBe(false);
    expect(a.follow).toBe('Which ones? Please tell me their names.');
    expect(turn(it1, 'medicines', 'ಕಬ್ಬಿಣ ಮಾತ್ರೆ').out.record.value).toBe('Iron');
  });

  it('medicines named in words the app does not know: her words kept for the ASHA', () => {
    const it1 = new Intake(1);
    turn(it1, 'medicines', 'ಹೌದು');
    const b = turn(it1, 'medicines', 'ಡಾಕ್ಟರ್ ಕೊಟ್ಟ ಬಿಳಿ ಮಾತ್ರೆ');
    expect(b.out.complete).toBe(true);
    expect(b.out.record.value).toBe('Yes: "ಡಾಕ್ಟರ್ ಕೊಟ್ಟ ಬಿಳಿ ಮಾತ್ರೆ" (check)');
  });

  it('conditions "yes" -> "Which ones?" -> "ಶುಗರ್" -> Diabetes', () => {
    const it1 = new Intake(1);
    expect(turn(it1, 'conditions', 'ಹೌದು ಇದೆ').follow).toBe('Which ones? Please tell me their names.');
    expect(turn(it1, 'conditions', 'ಶುಗರ್ ಇದೆ').out.record.value).toBe('Diabetes');
  });

  it('concerns "ಇದೆ ಇದೆ ಇದೆ" -> "Please tell me, what is it?" -> her words (and a sign in them is caught)', () => {
    const it1 = new Intake(1);
    const a = turn(it1, 'concerns', 'ಇದೆ ಇದೆ ಇದೆ');
    expect(a.out.complete).toBe(false);
    expect(a.follow).toBe('Please tell me, what is it?');
    const b = turn(it1, 'concerns', 'ಸ್ವಲ್ಪ ತಲೆನೋವು ಬರುತ್ತಿದೆ');
    expect(b.out.complete).toBe(true);
    expect(b.out.record.value).toContain('ತಲೆನೋವು');
    expect(b.out.reported).toContain('headache');
  });

  it('an answer with content is never treated as a bare yes ("ಹೌದು ಬೆಳೆಯುತ್ತಿದೆ")', () => {
    const it1 = new Intake(3);
    expect(turn(it1, 'tummySize', 'ಹೌದು ಬೆಳೆಯುತ್ತಿದೆ').out.complete).toBe(true);
  });
});
