// Which hex set thimble draws in (core/theme.ts): each of Claude Code's named themes by its kind, a custom theme by
// its base, and auto by what the terminal reports (COLORFGBG), else the set that reads on both backgrounds. All data is
// made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { resetTheme, themeNow, themeOf, themeOfFgbg } from '../core/theme'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test('the named themes, a custom theme by its base, and auto by COLORFGBG', () => {
  for (const t of ['light', 'light-daltonized', 'light-ansi']) expect(themeOf(t)).toBe('light')
  for (const t of ['dark', 'dark-daltonized', 'dark-ansi', undefined]) expect(themeOf(t)).toBe('dark')
  expect(themeOf('custom:paper', { base: 'light-daltonized' })).toBe('light')
  expect(themeOf('custom:night', { base: 'dark' })).toBe('dark')
  expect(themeOf('custom:night')).toBe('dark')
  // auto: the terminal's background color number, as Claude Code reads it (0–6 and 8 dark)
  expect(themeOfFgbg('0;15')).toBe('light')
  expect(themeOfFgbg('15;default;0')).toBe('dark')
  expect(themeOfFgbg('15;8')).toBe('dark')
  expect(themeOfFgbg('')).toBe(null)
  expect(themeOf('auto', { fgbg: '0;15' })).toBe('light')
  expect(themeOf('auto', { fgbg: '15;0' })).toBe('dark')
  // auto, the terminal says nothing: the light set, whose colors read on both backgrounds
  expect(themeOf('auto')).toBe('light')
})

test('themeNow reads the /config row, COLORFGBG for auto, and a custom theme\'s file', async () => {
  resetTheme()
  let now = 10_000
  let theme = 'auto'
  const read: string[] = []
  const env: Record<string, string> = { COLORFGBG: '15;0', HOME: '/made-up/home' }
  const $ = {
    clock: { now: async () => now, after: () => undefined },
    config: { list: async () => [{ key: 'theme', value: theme }] },
    env: { get: async (k: string) => env[k] },
    fs: { read: async (p: string) => { read.push(p); if (p !== '/made-up/home/.claude/themes/paper.json') throw new Error('missing'); return JSON.stringify({ name: 'Paper', base: 'light' }) } },
    ui: { invalidate: () => undefined },
  } as Any
  expect(await themeNow($)).toBe('dark')
  env.COLORFGBG = '0;15'
  now += 2000
  expect(await themeNow($)).toBe('light')
  theme = 'custom:paper'
  env.COLORFGBG = '15;0'
  now += 2000
  expect(await themeNow($)).toBe('light')
  expect(read).toEqual(['/made-up/home/.claude/themes/paper.json'])
  theme = 'dark-ansi'
  now += 500
  // read again only once the last read is a second old
  expect(await themeNow($)).toBe('light')
  now += 1000
  expect(await themeNow($)).toBe('dark')
  resetTheme()
})
