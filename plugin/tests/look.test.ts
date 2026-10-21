// How thimble's drawings look under Claude Code's own drawing of a press: a press is drawn inverse under the ring, so
// the ring never stands on a bar; the `auto` theme's neutrals are Claude Code's own colors; the bar names a
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

test('a row of words and a bar: the ring stands on its words, and a click on the bar opens the part too', () => {
  const cell = (ch: string, m?: number) => ({ ch, tone: m ? 'accent' : 'ink', ...(m ? { m } : {}) })
  const row = [...'fetch '].map(c => cell(c)).concat([...'▆▆▆▆'].map(c => cell(c, 1)), [...' 8,998'].map(c => cell(c)))
  const grid = { w: row.length, h: 1, rows: [row], regions: [{ id: 'value-1', rects: [{ x: 0, y: 0, w: row.length, h: 1 }] }] }
  const pressed: string[] = []
  const tree = paintRegions(grid as Any, els, { theme: 'light', key: 'pane', onPress: (id: string) => { pressed.push(id) } })
  const got = buttons(tree)
  expect(got.map(b => b.text)).toEqual(['fetch ', '▆▆▆▆', ' 8,998'])
  // the words keep the key the ring stands on, so the ring never draws the bar inverse; each press names the part
  expect(got[0]!.key).toBe('r|pane|0|value-1')
  expect(got.filter(b => b.text.includes('▆')).every(b => /\|#\d+$/.test(b.key))).toBe(true)
  expect(got.map(b => regionOfKey(b.key))).toEqual(['value-1', 'value-1', 'value-1'])
  // a click on the bar itself opens the part
  pressAll(tree, '▆▆▆▆')
  expect(pressed).toEqual(['value-1'])
})

test('a selected or hovered row keeps its bar as drawn: its words are bold, and the pointer over the bar turns the words inverse', () => {
  const cell = (ch: string, m?: number) => ({ ch, tone: m ? 'accent' : 'ink', ...(m ? { m } : {}) })
  const row = [...'fetch '].map(c => cell(c)).concat([...'▆▆▆▆'].map(c => cell(c, 1)), [...' 8,998'].map(c => cell(c)))
  const grid = { w: row.length, h: 1, rows: [row], regions: [{ id: 'value-1', rects: [{ x: 0, y: 0, w: row.length, h: 1 }] }] }
  const draw = (selected: string | null) => paintRegions(grid as Any, els, { theme: 'dark', key: 'pane', selected, onPress: () => {} })
  const texts = (n: Any, out: Any[] = []): Any[] => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { for (const x of n) texts(x, out); return out }
    if (n.type === 'Text' && typeof n.props.children === 'string') out.push(n.props)
    texts(n.props?.children, out)
    return out
  }
  const bar = (t: Any) => texts(t).find(p => p.children.includes('▆'))
  const words = (t: Any) => texts(t).find(p => p.children.startsWith('fetch'))
  // the selected bar is drawn exactly as an unselected one, and nothing of the row stands on the selection background
  expect(bar(draw('value-1'))).toEqual(bar(draw(null)))
  expect(texts(draw('value-1')).some(p => p.backgroundColor)).toBe(false)
  expect(words(draw('value-1')).bold).toBe(true)
  expect(words(draw('value-1')).color).toBe(words(draw(null)).color)
  // Claude Code draws a hovered press inverse: the bar's press opts out, and the row's words turn inverse instead
  const btns = (t: Any, out: Any[] = []): Any[] => {
    if (!t || typeof t !== 'object') return out
    if (Array.isArray(t)) { for (const x of t) btns(x, out); return out }
    if (t.type === 'Button') out.push(t.props)
    btns(t.props?.children, out)
    return out
  }
  const got = btns(draw('value-1'))
  const scope = got[0].hover.scope
  expect(scope.length <= 64).toBe(true)
  expect(got.map(b => [chars(b.children), b.hover])).toEqual([
    ['fetch ', { scope, inverse: true }], ['▆▆▆▆', { scope, inverse: false }], [' 8,998', { scope, inverse: true }],
  ])
})

/** Press the Button that holds `text`. */
function pressAll(n: Any, text: string): void {
  if (!n || typeof n !== 'object') return
  if (Array.isArray(n)) { for (const x of n) pressAll(x, text); return }
  if (n.type === 'Button' && chars(n.props.children) === text) n.props.onPress()
  pressAll(n.props?.children, text)
}

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
