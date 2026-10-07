// The visual system's checks (SPEC.md, section 8) over a reply that carries a card of each kind:
// bold only on a card's title, a table's column names and the model's Markdown; green only on `new`; blue only on links,
// `↗`, `?` and `↳`; no letters in a palette hue; one blank row under each card's title; every card in a full round border
// in the rule grey; non-ASCII glyphs only from the symbol table; no centred row; no inverse at rest.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { LABEL_HUES } from '../hooks/paint'
import { CWD, world } from './fixtures'

type M = Mounted<'terminal'>
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

// SPEC.md, section 5: the glyphs thimble-term draws besides the corpus's and the model's words (braille apart)
const SYMBOLS = new Set([...'○◌●!×✓❯?↳›‹↗▸▾⌕◆█▏▎▍▌▋▊▉▁▂▃▄▅▆▇─│├└┤┬┴╭╮╰╯→←↓↑┊▼▲…·'])
const PALETTE = new Set(['#1d7fc0', '#b77300', '#00946a', '#b96895', '#8c65e8', '#927543', '#87861a', ...LABEL_HUES])

/** Each Text leaf with the style it inherits: its words, colour, bold, underline, inverse. */
function leaves(n: unknown, style: Record<string, unknown> = {}, out: { s: string; st: Record<string, unknown> }[] = []): { s: string; st: Record<string, unknown> }[] {
  if (typeof n === 'string') out.push({ s: n, st: style })
  else if (Array.isArray(n)) n.forEach(k => leaves(k, style, out))
  else if (n && typeof n === 'object') {
    const o = n as Node
    const st = o.type === 'Text' ? { ...style, ...(o.props ?? {}) } : style
    leaves(o.children ?? (o.props?.children as unknown), st, out)
  }
  return out
}

function walk(n: unknown, f: (o: Node) => void): void {
  if (Array.isArray(n)) n.forEach(k => walk(k, f))
  else if (n && typeof n === 'object') {
    const o = n as Node
    f(o)
    walk(o.children ?? (o.props?.children as unknown), f)
  }
}

test('a reply with a card of each kind keeps the visual system: weight, colour, glyphs, borders, rows', async ($, on) => {
  const w = world(on)
  w.cells.l1line00 = { id: 'l1line00', notebook: 'g1', kind: 'plot', title: 'Saves per day', takeaway: '', labels: [], created_by: 'main', status: 'ok', outputs: [{ 'application/vnd.vegalite.v6.json': { mark: 'line', encoding: { x: { field: 'day', type: 'ordinal' }, y: { field: 'saves', type: 'quantitative' } }, data: { values: [{ day: 'Mon', saves: 3 }, { day: 'Tue', saves: 9 }, { day: 'Wed', saves: 4 }] } } }] }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  const ids = ['ff73e071', 'b0bar000', 'l1line00', 'e0time00', 'd0diag00', 'a20ecb55', 'n0note00', 'k0code00', 'l0label0']
  await $.turn.start({ text: 'Show me.', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '## Cards\n\nThe export holds **many** pages, see [[4579|card:ff73e071#pages/TOTAL]].' }] } } as never).catch(() => undefined)
  for (const [k, id] of ids.entries()) {
    w.toolText = id === 'l0label0' ? "The label's card is [[card:l0label0]]." : `card:${id}`
    await $.tool.call({ tool: id === 'l0label0' ? 'mcp__plugin_thimble_thimble__apply_label' : 'mcp__plugin_thimble_thimble__add_card', tool_use_id: `u${k}` } as never)
  }
  await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const text = '## Cards\n\nThe export holds **many** pages, see [[4579|card:ff73e071#pages/TOTAL]].'
  let ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const tree = await ui.drawn()
  const problems: string[] = []
  // every card in a full round border in the rule grey; no centred row
  let borders = 0
  walk(tree, o => {
    if (o.props?.borderStyle !== undefined) {
      borders++
      if (o.props.borderStyle !== 'round' || o.props.borderColor !== 'subtle') problems.push(`a border ${String(o.props.borderStyle)} ${String(o.props.borderColor)}`)
    }
    if (o.props?.justifyContent === 'center' || o.props?.alignItems === 'center') problems.push('a centred row')
  })
  expect(borders).toBe(ids.length)
  // inside each card
  for (const [k, id] of ids.entries()) {
    const key = `card-t${k}-${id}`
    await ui.resize({ columns: 120, rows: 30, in: key })
    const drawn = (await ui.drawn({ in: key })) as Node
    const rows = (drawn.children ?? []) as unknown[]
    if (rows.length < 3) problems.push(`${id}: ${rows.length} rows`)
    const title = leaves(rows[0])
    if (!title.length || !title.every(l => l.st.bold || !l.s.trim())) problems.push(`${id}: its title is not bold`)
    if (leaves(rows[1]).some(l => l.s.trim())) problems.push(`${id}: no blank row under its title`)
    rows.slice(1).forEach((r, y) => {
      for (const l of leaves(r)) {
        const words = l.s.trim()
        if (!words) continue
        // bold only on the title and a table's column names (its first body row)
        if (l.st.bold && !(y === 1 && (id === 'ff73e071'))) problems.push(`${id}: bold "${words}" on row ${y + 1}`)
        if (l.st.color === 'success' && words !== 'new') problems.push(`${id}: green "${words}"`)
        if (l.st.color === 'remember' && !(l.st.underline || /^[↗?↳]$/.test(words))) problems.push(`${id}: blue "${words}" that is no link`)
        if (PALETTE.has(String(l.st.color)) && /\p{L}/u.test(words)) problems.push(`${id}: letters "${words}" in a palette hue`)
        if (l.st.inverse) problems.push(`${id}: inverse "${words}" at rest`)
        for (const ch of words) if (ch.charCodeAt(0) > 127 && !SYMBOLS.has(ch) && !(ch >= '⠀' && ch <= '⣿')) problems.push(`${id}: the glyph ${ch} (${ch.codePointAt(0)!.toString(16)})`)
      }
    })
  }
  expect(problems).toEqual([])
  await ui.unmount()
})
