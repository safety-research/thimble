// The analyst's values always teach a prompt label's next run (backend concepts.few_shot_examples): Re-run says how many
// it carries as examples, and "% agreed" counts only the values the label was not given as examples, saying how many
// it counts and how many it left out (src/canvas/details.ts).
import { describe, expect, test } from 'vitest'
import { agreementLine, examplesNote } from '../../src/canvas/details.ts'

describe('Re-run of a label', () => {
  test("a prompt label's says how many of the analyst's values it carries, at most eight", () => {
    expect(examplesNote('prompt', 6)).toBe('uses your 6 values as examples')
    expect(examplesNote('prompt', 1)).toBe('uses your 1 value as examples')
    expect(examplesNote('prompt', 30)).toBe('uses your 8 values as examples')
  })
  test('says nothing with no value set, or for a regex or code label', () => {
    expect(examplesNote('prompt', 0)).toBe('')
    expect(examplesNote('prompt', undefined)).toBe('')
    expect(examplesNote('regex', 6)).toBe('')
    expect(examplesNote('code', 6)).toBe('')
  })
})

describe('the agreement', () => {
  test('counts the values not given as examples and says how many it left out', () => {
    expect(agreementLine({ n: 12, agreed: 9, taught: 6 })).toBe('75% agreed on 12 values you set, not counting the 6 given as examples')
    expect(agreementLine({ n: 1, agreed: 1, taught: 0 })).toBe('100% agreed on 1 value you set')
  })
  test('with every value given as examples, says none tests the label yet; with none set, nothing', () => {
    expect(agreementLine({ n: 0, agreed: 0, taught: 3 })).toBe('Your 3 values were given as examples, so none tests the label yet')
    expect(agreementLine({ n: 0, agreed: 0, taught: 0 })).toBe('')
    expect(agreementLine(null)).toBe('')
  })
})
