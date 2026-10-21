// The label row under a card and under an answer (shell/labeluse.ts labelRowEl): under a card each value has the
// color the card gives it, or a plain dim dot; under an answer, the label's own colors. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { labelRowEl } from '../shell/labeluse'
import { valueTone } from '../panes/labels.js'
import { termColor } from '../draw/palette.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Elements as their props, so the test reads what the row draws. */
const els = { Box: (p: Any) => ({ el: 'Box', ...p }), Button: (p: Any) => ({ el: 'Button', ...p }), Text: (p: Any) => ({ el: 'Text', ...p }) }

/** Each value's press: the dot's color (or dim) and its words. */
function dots(row: Any): { value: string; color?: string; dim?: boolean }[] {
  return row.children.filter((k: Any) => k.el === 'Button' && /that are/.test(k.label)).map((b: Any) => ({
    value: b.label.replace(/^.* that are /, ''),
    ...(b.children[0].color ? { color: b.children[0].color } : {}),
    ...(b.children[0].dimColor ? { dim: true } : {}),
  }))
}

test('under a card, a value has the color the card gives it, or a plain dim dot; under an answer, the label\'s own colors', () => {
  const label = { name: 'outcome', values: ['won', 'lost', 'tied'] }
  const open = () => undefined
  // the card draws `won` in a tone that is not the label's own for it, and `lost` and `tied` in none
  const card = labelRowEl(els, [{ ...label, tones: { won: 'c4' } }], { key: 'k', theme: 'dark', onOpen: open })
  expect(dots(card)).toEqual([{ value: 'won', color: termColor('c4', 'dark') }, { value: 'lost', dim: true }, { value: 'tied', dim: true }])
  const answer = labelRowEl(els, [label], { key: 'k', theme: 'dark', onOpen: open })
  expect(dots(answer).map(d => d.color)).toEqual(label.values.map(v => termColor(valueTone(label.values, v), 'dark')))
})

test('a regex label\'s row under a card is one line, as its own card\'s foot: how it was made and over how many records, never the pattern', () => {
  const label = { name: 'coord', kind: 'regex', rule: '(?i)coordinat|collab|cohort|\\bpeers?\\b|relay|please (append|post)', values: ['yes', 'no'], records: 13403 }
  const row = labelRowEl(els, [label], { key: 'k', theme: 'dark', onOpen: () => undefined })
  const words = (k: Any): string => (typeof k.children === 'string' ? k.children : Array.isArray(k.children) ? k.children.map(words).join('') : '')
  const text = row.children.map(words).join('')
  expect(text).toBe('label coord · regex · 13,403 records  ● yes  ● no')
})
