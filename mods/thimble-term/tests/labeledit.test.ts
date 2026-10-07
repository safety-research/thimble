// The label panel's parity with the browser's label editor and Labels pane: a label over files turned on or off in Files
// (`in files: on off`), a value's color chosen by the names show_label takes, a filter by a value, the held-out
// agreement and `… N more` records in the examples, rename, and the undo of a delete in the labels list. Each change
// goes through `thimble act` (label-show, label-filter, label, label-undelete). `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { LABEL_HUES } from '../hooks/paint'
import { CWD, LABEL, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[]; label?: string }

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 60 }, props: { title: 'thimble', isFocused: true, bodyColumns: 116, placement: 'dock', scroll: { bodyRows: 56 }, view: {} } } as never

/** The session, a turn that made the label's card, and its label panel opened from the card's label row. */
async function labelPanel($: E, w: World): Promise<M> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  w.toolText = "The label's card is [[card:l0label0]]."
  await $.turn.start({ text: 'Label it.', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Labelled.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__apply_label', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Labelled.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: LABEL.id, origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

/** Press `key` on the panel, then the panel drawn again. */
async function press($: E, w: World, pane: M, key: string): Promise<M> {
  await pane.press({ key })
  await w.clock.settle()
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
}

/** The label as `thimble state label` gives it, which a test changes to what thimble answers after an act. */
const label = (w: World) => w.states.labels[0] as Record<string, unknown>

// ------------------------------------------------------------------------------------------------ a text drawing

/** The rows a drawn tree takes in `w` cells, laid out about as Ink lays it out (a Box is a row unless it says column;
 *  a Box `width` its width; grow and gaps; round borders; a Text one row, wrapped where it says so): a drawing for a
 *  reader, not a check of Ink's layout. */
function rows(n: unknown, w: number): string[] {
  if (typeof n === 'string') return [n]
  if (Array.isArray(n)) return n.flatMap(k => rows(k, w))
  if (!n || typeof n !== 'object') return []
  const o = n as Node
  const p = o.props ?? {}
  const kids = (o.children ?? (p.children as unknown[] | undefined) ?? []) as unknown[]
  if (o.type === 'Text') {
    const s = flat(o)
    if (p.wrap === 'wrap' && s.length > w) {
      const out: string[] = []
      let line = ''
      for (const word of s.split(' ')) {
        if (line && line.length + 1 + word.length > w) {
          out.push(line)
          line = word
        } else line = line ? `${line} ${word}` : word
      }
      return [...out, line]
    }
    return [s.slice(0, w)]
  }
  if (o.type === 'Button') return [String(p.label ?? o.label ?? '')]
  if (o.type === 'Input') return [`${String(p.value ?? p.placeholder ?? '')}▏`]
  if (o.type === 'Client') {
    // a field's text, or a list's lines of segments (lines.tsx)
    const cp = (p.props ?? {}) as { text?: string; lines?: { s?: string }[][] }
    if (Array.isArray(cp.lines)) return cp.lines.map(l => l.map(x => x.s ?? '').join(''))
    return String(cp.text ?? '').split('\n')
  }
  if (o.type !== 'Box') return kids.flatMap(k => rows(k, w))
  if (p.width === 0 || p.height === 0) return []
  const border = p.borderStyle === 'round'
  const px = Number(p.paddingX ?? 0)
  const pad = (border ? 0 : Number(p.paddingLeft ?? px)) + Number(p.marginLeft ?? 0)
  const outer = (typeof p.width === 'number' ? p.width : w) - pad
  const inner = Math.max(1, border ? outer - 2 - 2 * px : outer)
  let body: string[]
  if (p.flexDirection === 'column') body = kids.flatMap(k => rows(k, inner))
  else {
    // a row: each child its natural width, a growing child the cells left, the gap between them
    const gap = Number(p.columnGap ?? 0)
    const parts = kids.map(k => ({ k, grow: Boolean((k as Node)?.props?.flexGrow), fixed: typeof (k as Node)?.props?.width === 'number' ? ((k as Node).props!.width as number) : null }))
    const natural = parts.map(x => (x.grow ? 0 : x.fixed ?? Math.max(0, ...rows(x.k, inner).map(r => [...r].length))))
    const left = Math.max(0, inner - natural.reduce((a, b) => a + b, 0) - gap * Math.max(0, parts.length - 1))
    const grown = parts.filter(x => x.grow).length
    const cols = parts.map((x, i) => {
      const cw = x.grow ? Math.floor(left / Math.max(1, grown)) : natural[i]!
      return { cw, lines: rows(x.k, Math.max(1, cw)) }
    })
    const h = Math.max(1, ...cols.map(c => c.lines.length))
    body = Array.from({ length: h }, (_, y) => cols.map(c => (c.lines[y] ?? '').padEnd(c.cw)).join(' '.repeat(gap)).replace(/\s+$/, ''))
    if (p.flexWrap === 'wrap' && body.length === 1 && body[0]!.length > inner) {
      // a wrapping row: its parts on as many rows as they need
      const out: string[] = []
      let line = ''
      for (const c of cols) {
        const s = c.lines[0] ?? ''
        if (line && line.length + gap + s.length > inner) {
          out.push(line)
          line = s
        } else line = line ? `${line}${' '.repeat(gap)}${s}` : s
      }
      body = [...out, line]
    }
  }
  if (border) {
    const bw = inner + 2 * px
    body = [`╭${'─'.repeat(bw)}╮`, ...body.map(r => `│${' '.repeat(px)}${r.padEnd(inner)}${' '.repeat(px)}│`), `╰${'─'.repeat(bw)}╯`]
  }
  return body.map(r => `${' '.repeat(pad)}${r}`)
}

function flat(n: unknown): string {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(flat).join('')
  if (!n || typeof n !== 'object') return ''
  const o = n as Node
  return flat(o.children ?? o.props?.children)
}

/** The panel at 120 columns as rows of text, printed for a reader of the test's output. */
async function drawing(pane: M, what: string): Promise<string> {
  const text = rows(await pane.drawn(), 118).map(r => r.replace(/\s+$/, '')).join('\n')
  console.log(`\n--- ${what} (120 columns)\n${text}\n---`)
  return text
}

// ------------------------------------------------------------------------------------------------ the tests

test('a label over files is turned on or off in Files from its panel: `in files:` lit on the one in use; o and a click send `label-show`', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  let text = shown(await pane.drawn())
  expect(text).toContain('in files:onoff')
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["off"]}')
  expect(text).toContain('o to show in files')
  // thimble answers the act with the label on
  label(w).shown = true
  pane = await press($, w, pane, 'hk-files-on')
  expect(w.acts).toContainEqual({ kind: 'label-show', payload: { label: LABEL.id, on: true } })
  text = shown(await pane.drawn())
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["on"]}')
  expect(text).toContain('o to hide in files')
  label(w).shown = false
  pane = await press($, w, pane, 'lo-off')
  expect(w.acts).toContainEqual({ kind: 'label-show', payload: { label: LABEL.id, on: false } })
  await pane.unmount()
})

test("a value's `color` shows the label colors by name under it, the one it has lit; a pick sends `label-show` with the name and its marks take the hue", async ($, on) => {
  const w = world(on)
  label(w).classes = [{ name: 'proxy-link', color: 2, highlight: true }, { name: 'none', color: 0, highlight: false }]
  let pane = await labelPanel($, w)
  // the label's ● in its first value's color: orange, the browser's label color 2
  expect(JSON.stringify(await pane.drawn())).toContain(`{"type":"Text","props":{"color":"${LABEL_HUES[1]}"},"children":["●"]}`)
  pane = await press($, w, pane, 'hk-counts')
  pane = await press($, w, pane, 'lb-color-proxy-link')
  const text = shown(await pane.drawn())
  for (const c of ['blue', 'orange', 'green', 'sky blue', 'olive', 'teal', 'brown', 'navy', 'grass green', 'cerulean', 'chestnut', 'cyan']) expect(text).toContain(c)
  // the color it has on the selection background, each other a click away, each ● in its hue
  const tree = JSON.stringify(await pane.drawn())
  expect(tree).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["orange"]}')
  expect(await pane.find({ type: 'Button', key: 'lb-pick-proxy-link-6' })).toBeDefined()
  expect(tree).toContain(`{"type":"Text","props":{"color":"${LABEL_HUES[5]}"},"children":["● "]}`)
  await drawing(pane, "the label panel, its counts open and proxy-link's colors shown")
  // thimble answers with proxy-link teal (show_label's names)
  label(w).classes = [{ name: 'proxy-link', color: 6, highlight: true }, { name: 'none', color: 0, highlight: false }]
  pane = await press($, w, pane, 'lb-pick-proxy-link-6')
  expect(w.acts).toContainEqual({ kind: 'label-show', payload: { label: LABEL.id, colours: { 'proxy-link': 'teal' } } })
  const after = JSON.stringify(await pane.drawn())
  // the colors gone from under it, its ● and bar teal; none, with no color, dim
  expect(shown(await pane.drawn())).not.toContain('grass green')
  expect(after).toContain(`{"type":"Text","props":{"color":"${LABEL_HUES[5]}"},"children":["● "]}`)
  expect(after).toMatch(new RegExp(`"color":"${LABEL_HUES[5]}"\\},"children":\\["█+"\\]`))
  expect(after).toContain('{"type":"Text","props":{"dimColor":true},"children":["● "]}')
  await pane.unmount()
})

test('`filter` keeps the units of one value (`label-filter`): that value lit, its control `clear filter`, the counts row says so; clearing sends no value', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-counts')
  expect(await pane.find({ type: 'Button', key: 'lb-filter-none' })).toMatchObject({ props: { label: 'filter' } })
  label(w).filter = 'none'
  label(w).shown = true
  pane = await press($, w, pane, 'lb-filter-none')
  expect(w.acts).toContainEqual({ kind: 'label-filter', payload: { label: LABEL.id, value: 'none' } })
  const text = shown(await pane.drawn())
  expect(text).toContain('counts  14,591 · filtered to none')
  expect(await pane.find({ type: 'Button', key: 'lb-filter-none' })).toMatchObject({ props: { label: 'clear filter' } })
  expect(await pane.find({ type: 'Button', key: 'lb-filter-proxy-link' })).toMatchObject({ props: { label: 'filter' } })
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["none      ')
  await drawing(pane, 'the label panel filtered to none')
  label(w).filter = null
  pane = await press($, w, pane, 'lb-filter-none')
  expect(w.acts.at(-1)).toEqual({ kind: 'label-filter', payload: { label: LABEL.id } })
  expect(shown(await pane.drawn())).not.toContain('filtered to')
  await pane.unmount()
})

test("the examples' row gives the label's held-out agreement; `… N more` under a value reads its next records (`state label --rows`)", async ($, on) => {
  const w = world(on)
  Object.assign(label(w), { calibration: { n: 10, agreed: 8, taught: 4 }, totals: { 'proxy-link': 5191, none: 9400 } })
  let pane = await labelPanel($, w)
  expect(shown(await pane.drawn())).toContain('examples  2 · 80% agreed on 10 values you set, not counting the 4 given as examples')
  pane = await press($, w, pane, 'hk-examples')
  expect(await pane.find({ type: 'Button', key: 'lb-more-proxy-link' })).toMatchObject({ props: { label: '… 5,190 more' } })
  expect(await pane.find({ type: 'Button', key: 'lb-more-none' })).toMatchObject({ props: { label: '… 9,399 more' } })
  await drawing(pane, 'the label panel, its examples open')
  pane = await press($, w, pane, 'lb-more-proxy-link')
  const asked = w.calls.filter(c => c[2] === 'label' && c.includes('--rows')).at(-1)
  expect(asked?.slice(-3)).toEqual([LABEL.id, '--rows', JSON.stringify({ 'proxy-link': 11 })])
  // a label no value of which the analyst set says nothing of agreement
  Object.assign(label(w), { calibration: { n: 0, agreed: 0, taught: 0 } })
  await pane.unmount()
})

test('`rename` (n) puts the name in a field in the run row\'s place; Enter sends `label {name}`, `keep the name` leaves it', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-rename')
  const field = (await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` })) as Node | undefined
  expect(field?.props).toMatchObject({ value: LABEL.name, submitLabel: 'rename' })
  // the run row gives way to the field, and its keys with it
  expect(await pane.find({ type: 'Button', key: 'lb-sample' })).toBeUndefined()
  expect(shown(await pane.drawn())).toContain('Enter to rename · Esc to leave the field')
  await drawing(pane, 'the label panel renaming the label')
  pane = await press($, w, pane, 'lb-rename-keep')
  expect(await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` })).toBeUndefined()
  expect(w.acts.some(a => a.kind === 'label')).toBe(false)
  pane = await press($, w, pane, 'lb-rename')
  label(w).name = 'fetch proxy links'
  await pane.input({ key: `lb-name-${LABEL.id}`, text: '  fetch   proxy links ' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label', payload: { label: LABEL.id, name: 'fetch proxy links' } })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('fetch proxy links')
  expect(await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` })).toBeUndefined()
  await pane.unmount()
})

test('after a delete the labels list offers `undo` (u): it sends `label-undelete` and opens the label again; a refusal says why in red', async ($, on) => {
  const w = world(on)
  const kept = JSON.parse(JSON.stringify(w.states.labels[0])) as Record<string, unknown>
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-delete')
  pane = await press($, w, pane, 'hk-delete-yes')
  let text = shown(await pane.drawn())
  expect(text).toContain(`deleted the label "${LABEL.name}"  undo`)
  expect(text).toContain('u to undo')
  await drawing(pane, 'the labels list after a delete')
  // thimble restores it
  w.states.labels = [kept] as never
  pane = await press($, w, pane, 'hk-undo')
  expect(w.acts).toContainEqual({ kind: 'label-undelete', payload: { label: LABEL.id } })
  text = shown(await pane.drawn())
  expect(text).toContain('name:')
  expect(text).toContain(LABEL.name)
  expect(w.toasts.join('\n')).toContain(`restored the label "${LABEL.name}"`)
  await pane.unmount()
})

test('an undo thimble refuses (a later change stands above the delete) says why on a red `×` row in place of `undo`', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-delete')
  pane = await press($, w, pane, 'hk-delete-yes')
  // thimble refuses a label-undelete once another change came after the delete
  w.refuse = { 'label-undelete': "the label's delete is no longer the last change, so it is not undone here" }
  pane = await press($, w, pane, 'lbs-undo')
  expect(w.acts.at(-1)).toEqual({ kind: 'label-undelete', payload: { label: LABEL.id } })
  expect(JSON.stringify(await pane.drawn())).toContain(`"color":"error","wrap":"wrap"},"children":["× the label \\"${LABEL.name}\\" was not restored: the label's delete is no longer the last change, so it is not undone here"]`)
  expect(shown(await pane.drawn())).not.toContain('u to undo')
  await pane.unmount()
})

test('the label panel at 120 columns, every part open', async ($, on) => {
  const w = world(on)
  Object.assign(label(w), {
    classes: [{ name: 'proxy-link', color: 2, highlight: true }, { name: 'none', color: 0, highlight: false }],
    shown: true,
    filter: 'proxy-link',
    calibration: { n: 10, agreed: 8, taught: 4 },
    totals: { 'proxy-link': 5191, none: 9400 },
  })
  let pane = await labelPanel($, w)
  await drawing(pane, 'the label panel as it opens')
  for (const k of ['hk-counts', 'hk-examples', 'hk-cards']) pane = await press($, w, pane, k)
  const text = await drawing(pane, 'the label panel, counts, examples and cards open')
  expect(text).toContain('in files:  on  off')
  expect(text).toMatch(/proxy-link\s+█+─*\s+5,191\s+36%\s+color\s+clear filter/)
  await pane.unmount()
})

test("in a narrow pane each value's `color` and `filter` stand on a row of their own under it, so its bar keeps its cells", async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-counts')
  await pane.unmount()
  const NARROW = { ...(PANE as unknown as Record<string, unknown>), viewport: { columns: 54, rows: 60 }, props: { title: 'thimble', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { bodyRows: 56 }, view: {} } } as never
  pane = (await $.ui.mount(NARROW)) as unknown as M
  const row = (await pane.find({ type: 'Box', key: 'lb-c-proxy-link-controls' })) as Node | undefined
  expect(row).toBeDefined()
  expect(shown(row)).toBe('color  filter')
  expect(shown(await pane.find({ type: 'Box', key: 'lb-c-proxy-link' }))).toMatch(/proxy-link {2}█+─+ {2}5,191 {4}36%$/)
  await pane.unmount()
})

test('each label color keeps 3:1 against white, a light panel, black and a dark panel, as the series do', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  expect(LABEL_HUES.length).toBe(12)
  for (const hue of LABEL_HUES) for (const bg of ['#ffffff', '#f0f0f0', '#000000', '#1e1e1e']) expect(ratio(hue, bg)).toBeGreaterThanOrEqual(3)
})

test("a label's values take their classes' colors on its card in the chat and on home, the negative dim", async ($, on) => {
  const w = world(on)
  label(w).classes = [{ name: 'proxy-link', color: 10, highlight: true }, { name: 'none', color: 0, highlight: false }]
  const pane = await labelPanel($, w)
  await pane.unmount()
  // the label card under the reply: proxy-link's bar cerulean (color 10), none's dim
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  const card = JSON.stringify(await ui.drawn({ in: 'card-t0-l0label0' }))
  expect(card).toMatch(new RegExp(`"color":"${LABEL_HUES[9]}"`))
  expect(card).not.toContain('#1d7fc0')
  await ui.unmount()
  // home's label row: its ● and its bar's first part cerulean
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const home = (await $.ui.mount(PANE)) as unknown as M
  const drawn = JSON.stringify(await home.drawn())
  expect(drawn).toContain(LABEL_HUES[9])
  expect(drawn).not.toContain('"#1d7fc0"')
  await home.unmount()
})
