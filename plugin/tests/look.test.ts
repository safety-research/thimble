// How thimble's drawings look under Claude Code's own drawing of a press: a press is drawn inverse under the ring, so
// the ring never stands on a bar; the `auto` theme's neutrals are Claude Code's own colors; the bar names a
// card as the person reads it. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

import { paintRegions, regionOfKey } from '../shell/cells'
import { isAutoTheme, objectWords, themeOf } from '../shell/shell'
import { hex, selectedMark, setAutoTheme, termColor } from '../draw/palette.js'

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

test('a selected or hovered row: its words bold, its bar a brighter shade of its own colors, nothing inverse', () => {
  const cell = (ch: string, m?: number, tone = 'c1') => ({ ch, tone: m ? tone : 'ink', ...(m ? { m } : {}) })
  const row = [...'fetch '].map(c => cell(c)).concat([...'▆▆▆'].map(c => cell(c, 1)), [...'▆▆'].map(c => cell(c, 1, 'c3')), [...' 8,998'].map(c => cell(c)))
  const grid = { w: row.length, h: 1, rows: [row], regions: [{ id: 'value-1', rects: [{ x: 0, y: 0, w: row.length, h: 1 }] }] }
  const draw = (selected: string | null) => paintRegions(grid as Any, els, { theme: 'dark', key: 'pane', selected, onPress: () => {} })
  const texts = (n: Any, out: Any[] = []): Any[] => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { for (const x of n) texts(x, out); return out }
    if (n.type === 'Text' && typeof n.props.children === 'string') out.push({ ...n.props, hover: n.hover ?? n.props.hover })
    texts(n.props?.children, out)
    return out
  }
  const bars = (t: Any) => texts(t).filter(p => p.children.includes('▆'))
  const words = (t: Any) => texts(t).find(p => p.children.startsWith('fetch'))
  // selected: each part of the stacked bar turns a shade of its own color, the parts stay apart, and no fill appears
  const [a0, b0] = bars(draw(null)), [a1, b1] = bars(draw('value-1'))
  expect(a1.color).toBe(selectedMark('c1', 'dark'))
  expect(b1.color).toBe(selectedMark('c3', 'dark'))
  expect(a1.color).not.toBe(a0.color)
  expect(b1.color).not.toBe(b0.color)
  expect(a1.color).not.toBe(b1.color)
  expect(texts(draw('value-1')).some(p => p.backgroundColor)).toBe(false)
  expect(words(draw('value-1')).bold).toBe(true)
  expect(words(draw('value-1')).color).toBe(words(draw(null)).color)
  // hovered: every press of the row is one hover group; none turns inverse, the words turn bold, the bar's parts light up
  const btns = (t: Any, out: Any[] = []): Any[] => {
    if (!t || typeof t !== 'object') return out
    if (Array.isArray(t)) { for (const x of t) btns(x, out); return out }
    if (t.type === 'Button') out.push({ ...t.props, hover: t.hover ?? t.props.hover })
    btns(t.props?.children, out)
    return out
  }
  const got = btns(draw(null))
  const scope = got[0].hover.scope
  expect(scope.length <= 64).toBe(true)
  expect(got.map(b => [chars(b.children), b.hover])).toEqual([
    ['fetch ', { scope, inverse: false, underline: false, bold: true }],
    ['▆▆▆▆▆', { scope, inverse: false, underline: false }],
    [' 8,998', { scope, inverse: false, underline: false, bold: true }],
  ])
  expect(bars(draw(null)).map(p => p.hover)).toEqual([{ scope, color: selectedMark('c1', 'dark') }, { scope, color: selectedMark('c3', 'dark') }])
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
