import type { Lang } from '@/i18n/strings';

import type { Visit } from './mockScreening';

// What the ASHA / health worker ENTERS (never asked by voice): measurements,
// examination findings, lab and scan results, registration numbers. The
// fields follow the MCP card, per visit. Every value is traceable: who
// entered it, when, and where it came from (measured, examined, a lab
// report, the MCP card). A test is never "missing": it is Done (with its
// result), Pending, Not available or Not needed, so a missing result is
// never read as a normal one.

export type Source = 'measured' | 'examination' | 'lab' | 'ultrasound' | 'mcp';
export type TestStatus = 'done' | 'pending' | 'unavailable' | 'not_indicated';

/** One entered value, with its trace. */
export type Entry = { value: string; by: string; at: number; source: Source };
/** One test / dose, with its status (and result once done). */
export type TestEntry = { status: TestStatus; result?: string; by: string; at: number };

export type ClinicalEntry = {
  visit: Visit;
  /** When this visit's entry was first saved (local day = one visit). */
  at: number;
  by: string;
  fields: Record<string, Entry>;
  tests: Record<string, TestEntry>;
  /** Which vitals series this entry added a point to (an edit replaces that point). */
  added?: Partial<Record<'sys' | 'dia' | 'weight' | 'hb', true>>;
};

/** What the screening rules read from the latest entry. */
export type ClinicalFacts = { bp?: [number, number]; pallor?: boolean; oedema?: boolean; hb?: number; weight?: number };

type L = Record<Lang, string>;
export type FieldKind =
  | { kind: 'number'; unit: string; min: number; max: number; decimals?: boolean }
  | { kind: 'bp' }
  | { kind: 'yesno' }
  | { kind: 'text' }
  | { kind: 'choice'; options: { id: string; label: L }[] };

export type Field = { id: string; label: L; visits: Visit[] } & FieldKind;
export type Group = { id: string; title: L; source: Source; visits: Visit[]; fields: Field[] };
/** A test: its status, and when done the result (a number, a choice or a word). */
export type Test = { id: string; label: L; visits: Visit[]; result?: FieldKind };

const ALL: Visit[] = [1, 2, 3];
const POS_NEG = { kind: 'choice' as const, options: [
  { id: 'negative', label: { en: 'Negative', kn: 'ನೆಗೆಟಿವ್', hi: 'नेगेटिव' } },
  { id: 'positive', label: { en: 'Positive', kn: 'ಪಾಸಿಟಿವ್', hi: 'पॉज़िटिव' } },
] };
const NIL_TRACE = { kind: 'choice' as const, options: [
  { id: 'nil', label: { en: 'Nil', kn: 'ಇಲ್ಲ', hi: 'नहीं' } },
  { id: 'trace', label: { en: 'Trace', kn: 'ಸ್ವಲ್ಪ', hi: 'थोड़ा' } },
  { id: '1+', label: { en: '1+ or more', kn: '1+ ಅಥವಾ ಹೆಚ್ಚು', hi: '1+ या ज़्यादा' } },
] };

export const CLINICAL_GROUPS: Group[] = [
  {
    id: 'registration',
    title: { en: 'Registration', kn: 'ನೋಂದಣಿ', hi: 'पंजीकरण' },
    source: 'mcp',
    visits: [1],
    fields: [
      { id: 'rchId', label: { en: 'RCH ID', kn: 'RCH ಐಡಿ', hi: 'RCH आईडी' }, visits: [1], kind: 'text' },
      { id: 'mcpNo', label: { en: 'MCP card number', kn: 'MCP ಕಾರ್ಡ್ ಸಂಖ್ಯೆ', hi: 'MCP कार्ड नंबर' }, visits: [1], kind: 'text' },
      { id: 'anm', label: { en: 'ANM name', kn: 'ANM ಹೆಸರು', hi: 'ANM का नाम' }, visits: [1], kind: 'text' },
      { id: 'regDate', label: { en: 'Date of registration', kn: 'ನೋಂದಣಿ ದಿನಾಂಕ', hi: 'पंजीकरण की तारीख' }, visits: [1], kind: 'text' },
      { id: 'ashaNameId', label: { en: 'ASHA name and ID', kn: 'ಆಶಾ ಹೆಸರು ಮತ್ತು ಐಡಿ', hi: 'आशा का नाम और आईडी' }, visits: [1], kind: 'text' },
      { id: 'phc', label: { en: 'PHC / health centre', kn: 'ಪ್ರಾ.ಆ.ಕೇಂದ್ರ / ಆರೋಗ್ಯ ಕೇಂದ್ರ', hi: 'PHC / स्वास्थ्य केंद्र' }, visits: [1], kind: 'text' },
      { id: 'phone', label: { en: 'Phone number', kn: 'ಫೋನ್ ಸಂಖ್ಯೆ', hi: 'फ़ोन नंबर' }, visits: [1], kind: 'text' },
    ],
  },
  {
    id: 'measurements',
    title: { en: 'Measurements', kn: 'ಅಳತೆಗಳು', hi: 'माप' },
    source: 'measured',
    visits: ALL,
    fields: [
      { id: 'bp', label: { en: 'Blood pressure', kn: 'ರಕ್ತದೊತ್ತಡ (ಬಿಪಿ)', hi: 'रक्तचाप (बीपी)' }, visits: ALL, kind: 'bp' },
      { id: 'weight', label: { en: 'Weight', kn: 'ತೂಕ', hi: 'वजन' }, visits: ALL, kind: 'number', unit: 'kg', min: 25, max: 150, decimals: true },
      { id: 'height', label: { en: 'Height', kn: 'ಎತ್ತರ', hi: 'लंबाई' }, visits: [1], kind: 'number', unit: 'cm', min: 120, max: 200 },
      { id: 'pulse', label: { en: 'Pulse', kn: 'ನಾಡಿ ಬಡಿತ', hi: 'नब्ज़' }, visits: ALL, kind: 'number', unit: '/min', min: 30, max: 200 },
      { id: 'resp', label: { en: 'Breathing rate', kn: 'ಉಸಿರಾಟದ ದರ', hi: 'सांस की दर' }, visits: [1], kind: 'number', unit: '/min', min: 6, max: 60 },
      { id: 'temp', label: { en: 'Temperature', kn: 'ದೇಹದ ಉಷ್ಣತೆ', hi: 'तापमान' }, visits: [1], kind: 'number', unit: '°F', min: 90, max: 110, decimals: true },
    ],
  },
  {
    id: 'examination',
    title: { en: 'Examination', kn: 'ಪರೀಕ್ಷೆ (ದೈಹಿಕ)', hi: 'जांच (शारीरिक)' },
    source: 'examination',
    visits: ALL,
    fields: [
      { id: 'pallor', label: { en: 'Pallor', kn: 'ಬಿಳುಪು (ರಕ್ತಹೀನತೆ)', hi: 'पीलापन' }, visits: ALL, kind: 'yesno' },
      { id: 'oedema', label: { en: 'Oedema (swelling)', kn: 'ಊತ', hi: 'सूजन' }, visits: ALL, kind: 'yesno' },
      { id: 'jaundice', label: { en: 'Jaundice', kn: 'ಕಾಮಾಲೆ', hi: 'पीलिया' }, visits: [1], kind: 'yesno' },
    ],
  },
  {
    id: 'abdomen',
    title: { en: 'Abdomen and baby', kn: 'ಹೊಟ್ಟೆ ಮತ್ತು ಮಗು', hi: 'पेट और बच्चा' },
    source: 'examination',
    visits: [2, 3],
    fields: [
      { id: 'fundalHeight', label: { en: 'Fundal height', kn: 'ಫಂಡಲ್ ಎತ್ತರ', hi: 'फंडल ऊंचाई' }, visits: [2, 3], kind: 'number', unit: 'cm', min: 8, max: 45 },
      { id: 'fhr', label: { en: "Baby's heart rate", kn: 'ಮಗುವಿನ ಹೃದಯ ಬಡಿತ', hi: 'बच्चे की धड़कन' }, visits: [2, 3], kind: 'number', unit: '/min', min: 60, max: 220 },
      { id: 'girth', label: { en: 'Abdominal girth', kn: 'ಹೊಟ್ಟೆಯ ಸುತ್ತಳತೆ', hi: 'पेट की गोलाई' }, visits: [3], kind: 'number', unit: 'cm', min: 50, max: 150 },
      {
        id: 'lie',
        label: { en: 'Lie / presentation', kn: 'ಮಗುವಿನ ಸ್ಥಾನ', hi: 'बच्चे की स्थिति' },
        visits: [3],
        kind: 'choice',
        options: [
          { id: 'cephalic', label: { en: 'Head down', kn: 'ತಲೆ ಕೆಳಗೆ', hi: 'सिर नीचे' } },
          { id: 'breech', label: { en: 'Breech', kn: 'ಕಾಲು ಕೆಳಗೆ', hi: 'पैर नीचे' } },
          { id: 'transverse', label: { en: 'Transverse', kn: 'ಅಡ್ಡ', hi: 'आड़ा' } },
        ],
      },
    ],
  },
  {
    // Framework, visits 2 and 3: "Visit details: date of visit, gestational age in weeks".
    id: 'visitDetails',
    title: { en: 'Visit details', kn: 'ಭೇಟಿಯ ವಿವರ', hi: 'विज़िट का विवरण' },
    source: 'mcp',
    visits: [2, 3],
    fields: [
      { id: 'visitDate', label: { en: 'Date of visit', kn: 'ಭೇಟಿಯ ದಿನಾಂಕ', hi: 'विज़िट की तारीख' }, visits: [2, 3], kind: 'text' },
      { id: 'gaWeeks', label: { en: 'Gestational age', kn: 'ಗರ್ಭದ ವಾರಗಳು', hi: 'गर्भ के सप्ताह' }, visits: [2, 3], kind: 'number', unit: 'weeks', min: 4, max: 42 },
    ],
  },
  {
    // Framework, section 7: "Medication and vaccination records" (the ASHA's, from the MCP card).
    id: 'medsVaccines',
    title: { en: 'Medicines and vaccines', kn: 'ಮಾತ್ರೆಗಳು ಮತ್ತು ಲಸಿಕೆ', hi: 'दवाइयां और टीके' },
    source: 'mcp',
    visits: ALL,
    fields: [
      { id: 'ifaGiven', label: { en: 'IFA tablets given', kn: 'ಕಬ್ಬಿಣಾಂಶ (IFA) ಮಾತ್ರೆ ನೀಡಲಾಗಿದೆ', hi: 'IFA गोलियां दी गईं' }, visits: ALL, kind: 'yesno' },
      { id: 'calciumGiven', label: { en: 'Calcium tablets given', kn: 'ಕ್ಯಾಲ್ಸಿಯಂ ಮಾತ್ರೆ ನೀಡಲಾಗಿದೆ', hi: 'कैल्शियम गोलियां दी गईं' }, visits: [2, 3], kind: 'yesno' },
      {
        id: 'tdDose',
        label: { en: 'Td vaccine', kn: 'ಟಿಡಿ (Td) ಲಸಿಕೆ', hi: 'टीडी (Td) टीका' },
        visits: ALL,
        kind: 'choice',
        options: [
          { id: 'td1', label: { en: 'Td-1 given', kn: 'Td-1 ನೀಡಲಾಗಿದೆ', hi: 'Td-1 दिया' } },
          { id: 'td2', label: { en: 'Td-2 given', kn: 'Td-2 ನೀಡಲಾಗಿದೆ', hi: 'Td-2 दिया' } },
          { id: 'booster', label: { en: 'Booster given', kn: 'ಬೂಸ್ಟರ್ ನೀಡಲಾಗಿದೆ', hi: 'बूस्टर दिया' } },
          { id: 'notDue', label: { en: 'Not due', kn: 'ಈಗ ಬೇಕಿಲ್ಲ', hi: 'अभी नहीं' } },
        ],
      },
      { id: 'otherMeds', label: { en: 'Other medicines given', kn: 'ನೀಡಿದ ಇತರ ಮಾತ್ರೆಗಳು', hi: 'दी गई अन्य दवाइयां' }, visits: ALL, kind: 'text' },
    ],
  },
  {
    // Framework, visit 3: "Risk assessment: existing risk factors and newly identified concerns".
    id: 'risk',
    title: { en: 'Risk assessment', kn: 'ಅಪಾಯದ ಮೌಲ್ಯಮಾಪನ', hi: 'जोखिम आकलन' },
    source: 'examination',
    visits: [3],
    fields: [
      { id: 'riskFactors', label: { en: 'Existing risk factors', kn: 'ಈಗಿರುವ ಅಪಾಯದ ಅಂಶಗಳು', hi: 'मौजूदा जोखिम कारक' }, visits: [3], kind: 'text' },
      { id: 'newConcerns', label: { en: 'Newly identified concerns', kn: 'ಹೊಸದಾಗಿ ಕಂಡ ಸಮಸ್ಯೆಗಳು', hi: 'नई पाई गई समस्याएं' }, visits: [3], kind: 'text' },
    ],
  },
  {
    id: 'birthPlan',
    title: { en: 'Birth preparedness', kn: 'ಹೆರಿಗೆ ಸಿದ್ಧತೆ', hi: 'प्रसव की तैयारी' },
    source: 'mcp',
    visits: [3],
    fields: [
      { id: 'facility', label: { en: 'Delivery facility', kn: 'ಹೆರಿಗೆ ಆಸ್ಪತ್ರೆ', hi: 'प्रसव का अस्पताल' }, visits: [3], kind: 'text' },
      { id: 'transport', label: { en: 'Emergency transport arranged', kn: 'ತುರ್ತು ವಾಹನ ವ್ಯವಸ್ಥೆ', hi: 'आपात वाहन की व्यवस्था' }, visits: [3], kind: 'yesno' },
      { id: 'supportPerson', label: { en: 'Support person', kn: 'ಜೊತೆಗೆ ಬರುವವರು', hi: 'साथ जाने वाले' }, visits: [3], kind: 'text' },
    ],
  },
  {
    // Framework: "Follow-up: referral, doctor's advice and next ANC date".
    id: 'followUp',
    title: { en: 'Follow-up', kn: 'ಮುಂದಿನ ಕ್ರಮ', hi: 'आगे की देखभाल' },
    source: 'mcp',
    visits: ALL,
    fields: [
      {
        id: 'referral',
        label: { en: 'Referral', kn: 'ರೆಫರಲ್', hi: 'रेफ़रल' },
        visits: ALL,
        kind: 'choice',
        options: [
          { id: 'none', label: { en: 'Not needed', kn: 'ಬೇಕಿಲ್ಲ', hi: 'ज़रूरत नहीं' } },
          { id: 'phc', label: { en: 'Referred to PHC', kn: 'ಪ್ರಾ.ಆ.ಕೇಂದ್ರಕ್ಕೆ ಕಳುಹಿಸಲಾಗಿದೆ', hi: 'PHC भेजा' } },
          { id: 'hospital', label: { en: 'Referred to hospital (FRU)', kn: 'ಆಸ್ಪತ್ರೆಗೆ (FRU) ಕಳುಹಿಸಲಾಗಿದೆ', hi: 'अस्पताल (FRU) भेजा' } },
        ],
      },
      { id: 'doctorAdvice', label: { en: "Doctor's advice", kn: 'ವೈದ್ಯರ ಸಲಹೆ', hi: 'डॉक्टर की सलाह' }, visits: ALL, kind: 'text' },
      { id: 'nextAnc', label: { en: 'Next ANC date', kn: 'ಮುಂದಿನ ತಪಾಸಣೆ ದಿನಾಂಕ', hi: 'अगली जांच की तारीख' }, visits: ALL, kind: 'text' },
    ],
  },
];

// The Lab report (app/asha/lab/[id].tsx): lab and scan results only.
// Medicines given and vaccines are entered with the visit (group 'medsVaccines').
export const CLINICAL_TESTS: Test[] = [
  { id: 'hb', label: { en: 'Haemoglobin (Hb)', kn: 'ಹಿಮೋಗ್ಲೋಬಿನ್ (Hb)', hi: 'हीमोग्लोबिन (Hb)' }, visits: ALL, result: { kind: 'number', unit: 'g/dL', min: 3, max: 20, decimals: true } },
  {
    id: 'bloodGroup',
    label: { en: 'Blood group', kn: 'ರಕ್ತದ ಗುಂಪು', hi: 'ब्लड ग्रुप' },
    visits: [1],
    result: { kind: 'choice', options: ['A', 'B', 'AB', 'O'].map((g) => ({ id: g, label: { en: g, kn: g, hi: g } })) },
  },
  { id: 'rh', label: { en: 'Rh factor', kn: 'Rh ಫ್ಯಾಕ್ಟರ್', hi: 'Rh फैक्टर' }, visits: [1], result: { kind: 'choice', options: [
    { id: '+', label: { en: 'Rh +', kn: 'Rh +', hi: 'Rh +' } },
    { id: '-', label: { en: 'Rh −', kn: 'Rh −', hi: 'Rh −' } },
  ] } },
  { id: 'urineRoutine', label: { en: 'Urine routine', kn: 'ಮೂತ್ರ ಪರೀಕ್ಷೆ', hi: 'पेशाब की जांच' }, visits: [1], result: { kind: 'text' } },
  { id: 'urineAlbumin', label: { en: 'Urine albumin', kn: 'ಮೂತ್ರದಲ್ಲಿ ಆಲ್ಬುಮಿನ್', hi: 'पेशाब में एल्बुमिन' }, visits: ALL, result: NIL_TRACE },
  { id: 'urineSugar', label: { en: 'Urine sugar', kn: 'ಮೂತ್ರದಲ್ಲಿ ಸಕ್ಕರೆ', hi: 'पेशाब में शुगर' }, visits: [1], result: NIL_TRACE },
  { id: 'hiv', label: { en: 'HIV screening', kn: 'HIV ಪರೀಕ್ಷೆ', hi: 'HIV जांच' }, visits: [1], result: POS_NEG },
  { id: 'syphilis', label: { en: 'Syphilis (VDRL / RPR)', kn: 'ಸಿಫಿಲಿಸ್ (VDRL / RPR)', hi: 'सिफलिस (VDRL / RPR)' }, visits: [1], result: POS_NEG },
  { id: 'hbsag', label: { en: 'HBsAg', kn: 'HBsAg', hi: 'HBsAg' }, visits: [1], result: POS_NEG },
  { id: 'glucose', label: { en: 'Blood glucose / DIPSI', kn: 'ರಕ್ತದಲ್ಲಿ ಸಕ್ಕರೆ / DIPSI', hi: 'ब्लड शुगर / DIPSI' }, visits: ALL, result: { kind: 'number', unit: 'mg/dL', min: 40, max: 500 } },
  { id: 'ultrasound', label: { en: 'Ultrasound', kn: 'ಸ್ಕ್ಯಾನ್ (ಅಲ್ಟ್ರಾಸೌಂಡ್)', hi: 'अल्ट्रासाउंड' }, visits: ALL, result: { kind: 'text' } },
];

export const groupsFor = (visit: Visit) =>
  CLINICAL_GROUPS.filter((g) => g.visits.includes(visit)).map((g) => ({ ...g, fields: g.fields.filter((f) => f.visits.includes(visit)) }));
export const testsFor = (visit: Visit) => CLINICAL_TESTS.filter((t) => t.visits.includes(visit));

/** "148/96" -> [148, 96] (systolic must be the larger, both in range). */
export function parseBp(v?: string): [number, number] | null {
  const m = v?.match(/^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/);
  if (!m) return null;
  const [s, d] = [Number(m[1]), Number(m[2])];
  return s >= 60 && s <= 260 && d >= 30 && d <= 160 && s > d ? [s, d] : null;
}

/** A field's value is in range (or empty): what Save checks. */
export function validField(f: FieldKind, v: string): boolean {
  if (!v.trim()) return true;
  if (f.kind === 'bp') return !!parseBp(v);
  if (f.kind === 'number') {
    const n = Number(v);
    return Number.isFinite(n) && n >= f.min && n <= f.max && (f.decimals || Number.isInteger(n));
  }
  return true;
}

/** The facts the rules read, from her latest clinical entry. */
export function clinicalFacts(entries?: ClinicalEntry[]): ClinicalFacts | undefined {
  const e = entries?.[0];
  if (!e) return undefined;
  const f = e.fields;
  const num = (v?: string) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const hb = e.tests.hb?.status === 'done' ? num(e.tests.hb.result) : undefined;
  return {
    bp: parseBp(f.bp?.value) ?? undefined,
    pallor: f.pallor?.value === 'yes' || undefined,
    oedema: f.oedema?.value === 'yes' || undefined,
    hb,
    weight: num(f.weight?.value),
  };
}

/** Is a measurement of this visit still missing (BP is the one that decides risk)? */
export function needsClinical(entries: ClinicalEntry[] | undefined, since: number) {
  const e = entries?.[0];
  return !e || e.at < since || !e.fields.bp;
}
