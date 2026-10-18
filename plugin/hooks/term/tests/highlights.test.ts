// A check's comment on a passage of Claude's answer (SPEC-v2 3.12): the passage tinted in the check's color with a flag
// in the margin; none with "Checks" off; a citation inside the tint opens the citation. The tint follows Claude Code's
// theme: a pale wash on a light one, a theme key while thimble cannot tell (`auto` and nothing that says the terminal's
// background), its words in the theme's text color. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { COLORS, labelHex, themeFrom, tintOf } from '../paint'
import { WS, aTurn, startSession, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
const SLOW = { timeoutMs: 30000 }
const FIRST = 'The board has two kinds of posts, coordination and status reports, and most of them came in the first week of June.'
const CLAIM = 'After 19 June there are 0 new messages to other agents on any page.'
const ANSWER = `${FIRST} ${CLAIM}\n\nThe rest are replies.`
const at = ANSWER.indexOf(CLAIM)
const comment = (over: Record<string, unknown> = {}) => ({ id: 'c1', check: 'important-details', check_name: 'Important details', color: 2, about: 'it looks for what a reader would likely miss', turn: 'r1', row: 'r1', ref: 'answer:r1#s2', start: at, end: at + CLAIM.length, quote: CLAIM, text: 'The label could not read 899 revisions whose text the dump hides.', details: '', status: 'open', at: '2026-10-16T16:06:00Z', ...over })

const MESSAGE = (columns: number, fullscreen = true, rows = 40) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns, rows, isFullscreen: fullscreen }, props: { text: ANSWER, isFirstOfReply: true } }) as never

/** A session with the answer row r1 and the checks' comments read (the answers area changed). */
async function answered($: Engine, w: World, comments: Record<string, unknown>[]): Promise<void> {
  await startSession($, w)
  await aTurn($, w, 'r1', ANSWER)
  w.comments = comments
  w.stamps.set(`${WS}/answer-comments.json`, 2)
  await w.clock.advance(1100)
}

/** The tints the paragraph's Client was handed, and its flag's Client, if any. */
async function tintsOf(ui: M): Promise<{ tints: { a: number; b: number; bg: string; id: string }[]; json: string }> {
  const json = JSON.stringify(await ui.drawn())
  const m = /"tints":(\[[^\]]*\])/.exec(json)
  return { tints: m ? (JSON.parse(m[1]!) as { a: number; b: number; bg: string; id: string }[]) : [], json }
}

test("a comment's passage is tinted in its check's color at 16%, with a flag in that color in the margin", SLOW, async ($, on) => {
  const w = world(on)
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints, json } = await tintsOf(ui)
  expect(tints.length).toBe(1)
  expect(tints[0]!.bg).toBe(tintOf(labelHex(2, 'dark'), 'dark', 0.16))
  expect(tints[0]!.id).toBe('c1')
  // the flag: ⚑ in the check's color (the label palette's place 2, as the browser's swatch)
  expect(json).toContain(`{"s":"⚑","fg":"${labelHex(2, 'dark')}"}`)
  await ui.unmount()
})

test('a citation inside a highlighted passage opens the citation; anywhere else on the highlight opens the comment', SLOW, async ($, on) => {
  // the more specific target wins
  const w = world(on)
  const cited = 'After 19 June there are [0](README.md#L3) new messages to other agents on any page.'
  const text = `${FIRST} ${cited}`
  const at0 = text.indexOf(cited)
  await startSession($, w)
  await aTurn($, w, 'r1', text)
  w.comments = [comment({ start: at0, end: at0 + cited.length, quote: cited })]
  w.stamps.set(`${WS}/answer-comments.json`, 2)
  await w.clock.advance(1100)
  const msg = { plugin: 'thimble', component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns: 150, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never
  let ui = (await $.ui.mount(msg)) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(msg)) as unknown as M
  const { tints, json } = await tintsOf(ui)
  expect(tints.map(t => t.id)).toEqual(['c1'])
  const para = /"key":"(para-\d+)"/.exec(json)![1]!
  // the citation's value `0`, inside the tint on row 0
  const x = FIRST.length + 1 + 'After 19 June there are '.length
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: para } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: para } as never)
  await w.clock.settle()
  expect(w.panes.at(-1)).toMatchObject({ title: 'Citation' })
  // the words before it (`are`), on the same tint: the comment
  await ui.pointer({ type: 'down', x: x - 4, y: 0, button: 'left', in: para } as never)
  await ui.pointer({ type: 'up', x: x - 4, y: 0, button: 'left', in: para } as never)
  await w.clock.settle()
  expect(w.panes.at(-1)).toMatchObject({ title: 'Important details' })
  await ui.unmount()
})

test('"Checks" off: no tint and no flag', { ...SLOW, options: { checks: false } }, async ($, on) => {
  const w = world(on)
  w.features.checks = false
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints, json } = await tintsOf(ui)
  expect(tints).toEqual([])
  expect(json).not.toContain('⚑')
  await ui.unmount()
})

/** WCAG's contrast ratio of two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
/** Every Text of a drawing that stands on `bg`, with its color. */
function onBackground(tree: unknown, bg: string): { color?: unknown; text: string }[] {
  const out: { color?: unknown; text: string }[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    const o = n as Node
    if (o.type === 'Text' && o.props?.backgroundColor === bg) out.push({ color: o.props.color, text: (o.children ?? []).filter(c => typeof c === 'string').join('') })
    for (const c of o.children ?? []) walk(c)
  }
  walk(tree)
  return out
}

test("Claude Code's theme setting, as Claude Code resolves it: light ones light, `auto` by COLORFGBG and else not known, a custom theme by its base", () => {
  for (const t of ['light', 'light-daltonized', 'light-ansi']) expect(themeFrom(t)).toBe('light')
  for (const t of ['dark', 'dark-daltonized', 'dark-ansi', '']) expect(themeFrom(t)).toBe('dark')
  // auto: the terminal's background, which Claude Code asks the terminal for and tells no plugin; COLORFGBG is its fallback
  expect(themeFrom('auto')).toBeNull()
  expect(themeFrom('auto', '0;15')).toBe('light')
  expect(themeFrom('auto', '15;default;0')).toBe('dark')
  expect(themeFrom('auto', '0;8')).toBe('dark')
  expect(themeFrom('auto', 'x')).toBeNull()
  expect(themeFrom('custom:paper', undefined, 'light')).toBe('light')
  expect(themeFrom('custom:night', undefined, 'dark-ansi')).toBe('dark')
  expect(themeFrom('custom:from-a-plugin')).toBeNull()
  expect(themeFrom('custom:paper (disabled in safe mode)')).toBe('dark')
})

test('on a light theme every check color is a pale wash under dark text (contrast at least 4.5), drawn and open', () => {
  for (let place = 1; place <= 8; place++) {
    for (const share of [0.16, 0.3]) {
      const bg = tintOf(labelHex(place, 'light'), 'light', share)
      // Claude Code's light text, rgb(0,0,0); its citation violet on the drawn tint too
      expect(contrast('#000000', bg)).toBeGreaterThanOrEqual(4.5)
      if (share === 0.16) expect(contrast('#8700ff', bg)).toBeGreaterThanOrEqual(4.5)
    }
    // on a dark theme, light text on a dark tint
    expect(contrast('#ffffff', tintOf(labelHex(place, 'dark'), 'dark', 0.3))).toBeGreaterThanOrEqual(4.5)
  }
})

test("a light theme: the passage is a pale wash of its check's color, its words in the theme's text color", SLOW, async ($, on) => {
  const w = world(on, { theme: 'light' })
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints, json } = await tintsOf(ui)
  const bg = tintOf(labelHex(2, 'light'), 'light', 0.16)
  expect(tints.map(t => t.bg)).toEqual([bg])
  expect(contrast('#000000', bg)).toBeGreaterThanOrEqual(4.5)
  expect(json).toContain(`{"s":"⚑","fg":"${labelHex(2, 'light')}"}`)
  const para = /"key":"(para-\d+)"/.exec(json)![1]!
  const lit = onBackground(await ui.drawn({ in: para } as never), bg)
  expect(lit.map(t => t.text).join(' ')).toContain('messages to other agents')
  expect(lit.every(t => t.color === COLORS.text)).toBe(true)
  await ui.unmount()
})

test('`auto` with nothing that says the terminal\'s background: the passage stands on a theme key, never a tint for a guessed theme', SLOW, async ($, on) => {
  const w = world(on, { theme: 'auto' })
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints } = await tintsOf(ui)
  expect(tints.map(t => t.bg)).toEqual([COLORS.wash])
  await ui.unmount()
})

test('`auto` in a terminal whose COLORFGBG says a light background: the pale wash', SLOW, async ($, on) => {
  const w = world(on, { theme: 'auto', env: { COLORFGBG: '0;15' } })
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints } = await tintsOf(ui)
  expect(tints.map(t => t.bg)).toEqual([tintOf(labelHex(2, 'light'), 'light', 0.16)])
  await ui.unmount()
})
