import { describe, expect, it } from '@jest/globals';

import { normalize } from '../normalize';

// Field: Gnani returned "ನನಗೆ ಇಪ್ಪತ್ತ್ನಾಲ್ಕು ವರ್ಷ" (24 in words, joined with a
// virama), which was not read as a number, so the age was asked again.
describe('Kannada number words, as Gnani and people spell them', () => {
  it.each([
    ['ಇಪ್ಪತ್ತನಾಲ್ಕು ವರ್ಷ', '24 ವರ್ಷ'],
    ['ಇಪ್ಪತ್ನಾಲ್ಕು ವರ್ಷ', '24 ವರ್ಷ'],
    ['ನನಗೆ ಇಪ್ಪತ್ತ್ನಾಲ್ಕು ವರ್ಷ', 'ನನಗೆ 24 ವರ್ಷ'],
    ['ಇಪ್ಪತ್ಮೂರು', '23'],
    ['ಮೂವತ್ತ್ಮೂರು', '33'],
    ['ಇಪ್ಪತ್ತೈದು', '25'],
    ['ಮೂವತ್ತೆರಡು', '32'],
    ['ಇಪ್ಪತ್ತು', '20'],
  ])('%s -> %s', (said, want) => {
    expect(normalize(said)).toBe(want);
  });
});
