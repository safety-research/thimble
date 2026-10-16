// The palette from the browser's tokens (SPEC-v2 3.19): palette.gen.ts, which scripts/dev/sync_palette.py writes from
// frontend/src/styles/tokens.css (the frontend's viz-palette test holds it to the tokens and fails when it is stale),
// filled into the arrays the drawing reads by theme; a check's color is a label place; a tint blends toward the theme's
// ground. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { COLORS, FLAG, LABEL_HUES, PICKED_HUES, SERIES, labelHex, setTheme, themeNow, tintOf } from '../paint'
import { LABEL_DARK, LABEL_LIGHT, PICKED_DARK, PICKED_LIGHT, SERIES_DARK, SERIES_LIGHT } from '../palette.gen'

const HEX = /^#[0-9a-f]{6}$/

test('the generated palette: seven series, twelve label places and six picked ones per theme, each a hex', () => {
  for (const [list, n] of [[SERIES_LIGHT, 7], [SERIES_DARK, 7], [LABEL_LIGHT, 12], [LABEL_DARK, 12], [PICKED_LIGHT, 6], [PICKED_DARK, 6]] as const) {
    expect(list.length).toBe(n)
    for (const c of list) expect(c).toMatch(HEX)
  }
  // the default accent (iris) starts the series at violet
  expect(SERIES_LIGHT[0]).toBe('#5e4bd6')
  expect(SERIES_DARK[0]).toBe('#8b86f9')
})

test("the drawing's arrays hold the theme's palette, filled in place, so the cards repaint", () => {
  try {
    setTheme('light')
    expect(themeNow()).toBe('light')
    expect([...SERIES]).toEqual([...SERIES_LIGHT])
    expect([...LABEL_HUES]).toEqual([...LABEL_LIGHT])
    expect([...PICKED_HUES]).toEqual([...PICKED_LIGHT])
    expect(COLORS.series).toBe(SERIES)
    setTheme('dark')
    expect([...COLORS.series]).toEqual([...SERIES_DARK])
    expect([...LABEL_HUES]).toEqual([...LABEL_DARK])
  } finally {
    setTheme('dark')
  }
})

test("a check's color is its label place, 1-8, in the theme's palette; picked places 13-18; a tint blends toward the ground", () => {
  expect(labelHex(2, 'dark')).toBe(LABEL_DARK[1])
  expect(labelHex(5, 'light')).toBe(LABEL_LIGHT[4])
  expect(labelHex(13, 'light')).toBe(PICKED_LIGHT[0])
  expect(labelHex(18, 'dark')).toBe(PICKED_DARK[5])
  expect(tintOf('#ffffff', 'dark', 0.16)).toBe('#424242')
  expect(tintOf('#000000', 'light', 0.3)).toBe('#b3b3b3')
  expect(tintOf('#1e1e1e', 'dark', 0.5)).toBe('#1e1e1e')
  expect(FLAG).toBe('⚑')
})
