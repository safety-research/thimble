// How thimble's drawings look under Claude Code's own drawing of a press: a press is drawn inverse under the pointer
// and the ring, so a bar is never inside one; the `auto` theme's neutrals are Claude Code's own colors; the bar names a
// card as the person reads it. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

import { paintRegions, regionOfKey } from '../shell/cells'
import { isAutoTheme, objectWords, themeOf } from '../shell/shell'
import { hex, setAutoTheme, termColor } from '../draw/palette.js'

const els = {
  Box: (p: Any) => ({ type: 'Box', props: p }),
  Text: (p: Any) => ({ type: 'Text', props: p }),
  Button: (p: Any) => ({ type: 'Button', props: p }),
}
/** Every Button in a tree, with the characters it holds. */
function buttons(n: Any, out: { key: string; text: string }[] = []): { key: string; text: string }[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const x of n) buttons(x, out); return out }
  if (n.type === 'Button') out.push({ key: String(n.props.key), text: chars(n.props.children) })
  buttons(n.props?.children, out)
  return out
}
const chars = (n: Any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(chars).join('') : n?.props ? chars(n.props.children) : '')

test('a row of words and a bar is a press on its words: the bar is drawn beside them, never inside a press', () => {
  const cell = (ch: string, m?: number) => ({ ch, tone: m ? 'accent' : 'ink', ...(m ? { m } : {}) })
  const row = [...'fetch '].map(c => cell(c)).concat([...'▆▆▆▆'].map(c => cell(c, 1)), [...' 8,998'].map(c => cell(c)))
  const grid = { w: row.length, h: 1, rows: [row], regions: [{ id: 'value-1', rects: [{ x: 0, y: 0, w: row.length, h: 1 }] }] }
  const got = buttons(paintRegions(grid as Any, els, { theme: 'light', key: 'pane', onPress: () => {} }))
  expect(got.map(b => b.text)).toEqual(['fetch ', ' 8,998'])
  expect(got.some(b => b.text.includes('▆'))).toBe(false)
  // the first keeps the key the ring stands on; each names the part
  expect(got[0]!.key).toBe('r|pane|0|value-1')
  expect(got.map(b => regionOfKey(b.key))).toEqual(['value-1', 'value-1'])
})

test("Claude Code's auto theme: the light palette only for a light theme, and a bar's track in Claude Code's own pale gray", () => {
  expect([themeOf('light'), themeOf('light-ansi'), themeOf('dark'), themeOf('auto')]).toEqual(['light', 'light', 'dark', 'dark'])
  expect([isAutoTheme('auto'), isAutoTheme('dark-daltonized'), isAutoTheme('light')]).toEqual([true, false, false])
  const dark = hex('dim-faint', 'dark')
  try {
    setAutoTheme(true)
    expect(termColor('dim-faint', 'dark')).toBe('subtle')
    expect(termColor('dim', 'dark')).toBe('inactive')
    // a colored faint tone steps toward a middle gray, not the dark paper
    expect(hex('c1-faint', 'dark')).not.toBe(dark)
  } finally {
    setAutoTheme(false)
  }
  expect(termColor('dim-faint', 'dark')).toBe(dark)
})

test('the bar names a card as the person reads it, not by its saved id', () => {
  expect(objectWords('01-label-kind')).toBe('label kind')
  expect(objectWords('shape_of_saves')).toBe('shape of saves')
})
