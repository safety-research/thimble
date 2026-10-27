// @vitest-environment jsdom
// A takeaway edited in place (src/canvas/RefEditor.tsx): each claim's mark, `[1,204](#)`, is a token as each cited
// number and bare ref is, drawn as the card draws it (its words, underlined as a citation) and never as its markup; a ref
// written in a mark's words stays in the mark; what the analyst types around the tokens is saved with each token written
// back as the markup it came from; and the field has no spell check, since a takeaway names the data's own words.
import { afterEach, expect, test } from 'vitest'
import { markupOf, RefEditor, refParts } from '../../src/canvas/RefEditor.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const TAKEAWAY = 'North and Harbor logged about the same rain, [1,204](#) and [1,187](#) mm, but most rain at North fell in winter ([815](#)); see [[31|card:ab12cd34#mm/north]].'

test('a mark is a token of its own beside the cited numbers and bare refs, and a ref in its words stays in it', () => {
  const parts = refParts('[1,204](#) mm at [card:ab12cd34 alone](#), [[31|card:ab12cd34#mm/north]] and card:ab12cd34.')
  expect(parts.flatMap((p) => ('raw' in p ? [[p.raw, p.ref, p.value]] : []))).toEqual([
    ['[1,204](#)', null, '1,204'],
    ['[card:ab12cd34 alone](#)', null, 'card:ab12cd34 alone'],
    ['[[31|card:ab12cd34#mm/north]]', 'card:ab12cd34#mm/north', '31'],
    ['card:ab12cd34', 'card:ab12cd34', undefined],
  ])
})

test('the editor shows the marks as the card draws them, with no spell check, and saves them as they were written', async () => {
  const el = await mount(<RefEditor value={TAKEAWAY} onDone={() => undefined} label="Takeaway" />)
  const field = el.querySelector<HTMLElement>('.refedit')!
  expect(field.textContent).not.toContain('](#)')
  expect([...field.querySelectorAll('.refedit-token.refchip-citation')].map((t) => t.textContent)).toEqual(['1,204', '1,187', '815', '31'])
  expect(field.getAttribute('spellcheck')).toBe('false')
  // the analyst types after the last token
  field.append(' Checked by hand.')
  expect(markupOf(field)).toBe(`${TAKEAWAY} Checked by hand.`)
})
