// The label panel's parity with the browser's label editor (mockup labelpanel2): every field exposed and editable for
// each kind of label, a label's records marked in Files and the views or not (`highlight:  on
// off`), a code label's colored code, a pattern's note, and rename in the name's field. Each change goes through
// `thimble act` (label-show, label). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { regexNote } from '../labels'
import { codeParts } from '../field'
import { CWD, LABEL, shown, world } from './fixtures'
import type { World } from './fixtures'

// the test's own output: its drawings, for a reader
declare const console: { log: (...args: unknown[]) => void }

type M = Mounted<'terminal'>
type E = Engine
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[]; label?: string }

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 60 }, props: { title: 'thimble', isFocused: true, bodyColumns: 116, placement: 'dock', scroll: { bodyRows: 56 }, view: {} } } as never

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
  // a Button: its label, else its words (an action's words are its child, chrome.tsx actionEl)
  if (o.type === 'Button') return [String(p.label ?? o.label ?? flat(o))]
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
    // one line of parts side by side, as tall as its tallest part
    const side = (line: typeof cols) =>
      Array.from({ length: Math.max(1, ...line.map(c => c.lines.length)) }, (_, y) => line.map(c => (c.lines[y] ?? '').padEnd(c.cw)).join(' '.repeat(gap)).replace(/\s+$/, ''))
    body = side(cols)
    if (p.flexWrap === 'wrap' && Math.max(...body.map(r => r.length)) > inner) {
      // a wrapping row: its parts on as many lines as they need, `rowGap` blank rows between the lines
      const lines: (typeof cols)[] = []
      let at = 0
      for (const c of cols) {
        if (lines.length && at + gap + c.cw <= inner) {
          lines[lines.length - 1]!.push(c)
          at += gap + c.cw
        } else {
          lines.push([c])
          at = c.cw
        }
      }
      body = lines.flatMap((line, i) => [...Array.from({ length: i ? Number(p.rowGap ?? 0) : 0 }, () => ''), ...side(line)])
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

/** A drawing's rows without the panel's margin of 3 cells. */
const bare = (t: string) => t.split('\n').map(r => r.replace(/^ {3}/, '')).join('\n')

/** The panel at 120 columns (or `columns`) as rows of text, printed for a reader of the test's output. */
async function drawing(pane: M, what: string, columns = 120): Promise<string> {
  const text = rows(await pane.drawn(), columns - 2).map(r => r.replace(/\s+$/, '')).join('\n')
  console.log(`\n--- ${what} (${columns} columns)\n${text}\n---`)
  return text
}

// ------------------------------------------------------------------------------------------------ the tests

// the four kinds of label the mockup draws (labelpanel2): a prompt label over a file, a regex label over many files, a
// code label over a database table, a prompt label over the canvas's cards
const MODELS = { model_id: 'claude-haiku-5-5', model_role: 'claude-haiku-5-5', model_choices: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], model: '' }
const ran = (n: number) => ({ total: n, matched_total: n, labeled: n, status: 'done', limit: null })
const CODE = 'def label(pr):\n    if not pr["merged_at"]:\n        return "never merged", 1.0\n    hours = (pr["merged_at"] - pr["opened_at"]) / 3600\n    return ("fast" if hours < 2 else "slow"), 1.0'
const KINDS_SHOWN = [
  {
    what: 'a prompt label over a file',
    label: { ...LABEL, ...MODELS, name: 'message to agents', kind: 'prompt', description: 'Is this post a message addressed to one or more other agents, rather than a status note to no one in particular?', spec: '', glob: 'board.jsonl', scope_files: 1, scope_unit: 'lines', labels: ['yes', 'no', 'unsure'], label_stats: { n_labeled: 44, counts: { yes: 17, no: 25, unsure: 2 } }, last_run: ran(44), shown: true, run_model: 'Haiku 5.5' },
    rows: [
      /^name: {6}● message to agents▏$/,
      /^kind: {6}prompt {3}regex {3}code$/,
      /^model: {5}claude-haiku-5-5 ▾$/,
      /^unit: {6}records of files {3}whole files {3}runs {3}cards {3}sentences$/,
      /^scope: {5}board\.jsonl▏ {24}· 1 file matches · 44 lines$/,
      /^highlight: on {3}off$/,
      /^─+$/,
      /^ {10}╭─+╮$/,
      /^prompt: {3}│ Is this post a message addressed to one or more other agents, rather than/,
      /^values:$/,
      /^ {10}● yes {5}━{20} {12}17$/,
      /^ {10}● no {6}━{30} {2}25$/,
      /^ {10}● unsure {2}━{2} {31}2$/,
      /^last run on all 44 lines$/,
      /^run on 30 of 44 lines {3}run on all 44 lines {3}rename {3}delete$/,
      /^↑↓ to choose · Enter to press or edit/,
    ],
    chosen: [' prompt ', ' records of files ', ' on '],
  },
  {
    what: 'a regex label over many files',
    label: { ...LABEL, ...MODELS, name: 'mentions force-push', kind: 'regex', spec: 'force[- ]push|--force', glob: 'agents/*.jsonl', scope_files: 48, scope_unit: 'lines', labels: ['yes', 'no'], label_stats: { n_labeled: 840, counts: { yes: 9, no: 831 } }, last_run: ran(840), shown: false },
    rows: [
      /^kind: {6}prompt {3}regex {3}code$/,
      /^unit: {6}records of files {3}whole files {3}runs {3}cards {3}sentences$/,
      /^scope: {5}agents\/\*\.jsonl▏ +· 48 files match · 840 lines$/,
      /^highlight: on {3}off$/,
      /^pattern: {2}│ force\[- \]push\|--force +│$/,
      /^ {10}│ a match is yes, the rest no · case-sensitive +│$/,
      /^ {10}● yes {2}━ {32}9$/,
      /^ {10}● no {3}━{30} 831$/,
      /^last run on all 840 lines$/,
    ],
    chosen: [' regex ', ' records of files ', ' off '],
  },
  {
    what: 'a code label over a database table',
    label: { ...LABEL, ...MODELS, name: 'merge delay', kind: 'code', spec: CODE, glob: 'forge.db#prs', scope_files: 1, scope_unit: 'rows', labels: ['fast', 'slow', 'never merged'], label_stats: { n_labeled: 36, counts: { fast: 20, slow: 12, 'never merged': 4 } }, last_run: ran(36), shown: true },
    rows: [
      /^kind: {6}prompt {3}regex {3}code$/,
      /^scope: {5}forge\.db#prs▏ +· 1 file matches · 36 rows$/,
      /^code: {5}│ def label\(pr\): +│$/,
      /^ {10}│ {5}return \("fast" if hours < 2 else "slow"\), 1\.0 +│$/,
      /^ {10}● never merged {2}━{6} {27}4$/,
      /^last run on all 36 rows$/,
    ],
    chosen: [' code ', ' records of files ', ' on '],
  },
  {
    what: "a prompt label over the canvas's cards",
    label: { ...LABEL, ...MODELS, name: 'claims a number', kind: 'prompt', description: "Does the card's takeaway state a number as a finding?", spec: '', unit: 'cell', glob: '', labels: ['yes', 'no'], label_stats: { n_labeled: 9, counts: { yes: 6, no: 3 } }, last_run: ran(9) },
    rows: [
      /^model: {5}claude-haiku-5-5 ▾$/,
      /^unit: {6}records of files {3}whole files {3}runs {3}cards {3}sentences$/,
      /^scope: {4}the canvas's cards · 9 cards$/,
      /^prompt: {3}│ Does the card's takeaway state a number as a finding\? +│$/,
      /^ {10}● yes {2}━{30} {3}6$/,
      /^last run on all 9 cards$/,
    ],
    chosen: [' prompt ', ' cards '],
  },
]

for (const c of KINDS_SHOWN)
  test(`the label panel shows every field as the browser's editor does, each editable where the browser's is: ${c.what}`, { timeoutMs: 30_000 }, async ($, on) => {
    // kind, scope and the rest exposed and editable like the browser, the model among
    // them, the actions clickable, "in files" clear (mockup labelpanel2)
    const w = world(on)
    w.states.labels = [c.label] as never
    const pane = await labelPanel($, w)
    const text = bare(await drawing(pane, `the label panel: ${c.what}`)).split('\n')
    for (const re of c.rows) expect(text.find(r => re.test(r)), String(re)).toBeDefined()
    // the choices in use on the selection background, one cell around their words
    const json = JSON.stringify(await pane.drawn())
    for (const words of c.chosen) expect(json).toContain(`{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["${words}"]}`)
    // the name in a field on the selection background, its ● in the label's color
    expect((await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` }))?.props).toMatchObject({ value: c.label.name, submitLabel: 'rename' })
    expect(json).toContain('{"type":"Box","props":{"width":40,"backgroundColor":"selectionBg","paddingLeft":1,"flexDirection":"row"}')
    // the definition in its field, from the label column to the pane's edge
    expect(await pane.find({ type: 'Client', key: `lb-def-${LABEL.id}-${c.label.kind}` })).toBeDefined()
    // the unit is the one it was made with, as in the browser: the others cannot be picked
    for (const u of ['record', 'agent', 'run', 'cell', 'span']) expect(await pane.find({ type: 'Button', key: `lu-${u}` })).toBeUndefined()
    await pane.unmount()
  })

test("a label over files marks its records in Files and the views or not: `highlight:  on  off`, the one in use lit; f and a click send `label-show`", async ($, on) => {
  // 0.9.0 (SPEC-v2 J4): `o` opens every view's object in the browser, so the label's marks switch is `f`;
  // `in files: on off` did not say what it turns on; mockup labelpanel2 says it in the row's label
  const w = world(on)
  let pane = await labelPanel($, w)
  let text = shown(await pane.drawn())
  expect(text).toContain('highlight: on  off ')
  expect(text).not.toContain('in files:')
  expect(text).not.toContain('marks:')
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":[" off "]}')
  expect((await pane.find({ type: 'Button', key: 'lo-on' }))?.props).toMatchObject({ label: ' on ', dimColor: true })
  // thimble answers the act with the label on
  label(w).shown = true
  pane = await press($, w, pane, 'hk-files-on')
  expect(w.acts).toContainEqual({ kind: 'label-show', payload: { label: LABEL.id, on: true } })
  text = JSON.stringify(await pane.drawn())
  expect(text).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":[" on "]}')
  expect(await pane.find({ type: 'Button', key: 'lo-off' })).toBeDefined()
  label(w).shown = false
  pane = await press($, w, pane, 'lo-off')
  expect(w.acts).toContainEqual({ kind: 'label-show', payload: { label: LABEL.id, on: false } })
  expect(await pane.find({ type: 'Button', key: 'lo-on' })).toBeDefined()
  await pane.unmount()
})

test("a code label's code has its keywords and strings colored in its field, its comments dim, as the mockup draws it", async ($, on) => {
  const w = world(on)
  w.states.labels = [{ ...KINDS_SHOWN[2]!.label, spec: `${CODE}  # by the hour` }] as never
  const pane = await labelPanel($, w)
  const field = `lb-def-${LABEL.id}-code`
  expect((await pane.find({ type: 'Client', key: field }))?.props).toMatchObject({ props: { multiline: true, code: { keyword: 'merged', string: 'success' } } })
  const drawn = JSON.stringify(await pane.drawn({ in: field }))
  expect(drawn).toContain('{"type":"Text","props":{"color":"merged"},"children":["def"]}')
  expect(drawn).toContain('{"type":"Text","props":{"color":"merged"},"children":["not"]}')
  expect(drawn).toContain('{"type":"Text","props":{"color":"success"},"children":["\\"never merged\\""]}')
  expect(drawn).toContain('{"type":"Text","props":{"dimColor":true},"children":["# by the hour"]}')
  // a name that holds a keyword is no keyword; a click gives the field the keyboard, its row with the cursor plain
  expect(drawn).not.toContain('"children":["if"]},"_merged')
  await pane.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: field } as never)
  const after = (((await pane.drawn({ in: field })) as { children?: unknown[] }).children ?? []) as unknown[]
  expect(JSON.stringify(after[0])).toContain('"inverse":true')
  expect(JSON.stringify(after[0])).not.toContain('"color":"merged"')
  expect(JSON.stringify(after[1])).toContain('"color":"merged"')
  await pane.unmount()
})

test('a pattern says under it what a match gives, case-insensitive only where it turns case off', () => {
  expect(regexNote(['proxy-link', 'none'], 'r\\.jina\\.ai')).toBe('a match is proxy-link, the rest none · case-sensitive')
  expect(regexNote(['yes', 'no'], '(?i)force[- ]push')).toBe('a match is yes, the rest no · case-insensitive')
  expect(regexNote(['yes', 'no'], '(?ai)x')).toBe('a match is yes, the rest no · case-insensitive')
  expect(regexNote([], '(?:i)')).toBe('a match is yes, the rest no · case-sensitive')
  expect(codeParts('x = "a # b"  # c', { keyword: 'k', string: 's' })).toEqual([{ s: 'x = ' }, { s: '"a # b"', color: 's' }, { s: '  ' }, { s: '# c', dim: true }])
  expect(codeParts('ifx = notable', { keyword: 'k', string: 's' })).toEqual([{ s: 'ifx = notable' }])
})

test("the name is a field: Enter sends `label {name}`; `rename` (n) gives it the keyboard", async ($, on) => {
  // mockup labelpanel2: the name exposed and editable like the browser's, `rename` among the actions
  const w = world(on)
  let pane = await labelPanel($, w)
  const field = (await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` })) as Node | undefined
  expect(field?.props).toMatchObject({ value: LABEL.name, submitLabel: 'rename' })
  // n asks Claude Code to move the ring onto the name's field (played here as Claude Code moves it, keys.test.ts)
  await pane.press({ key: 'hk-rename' })
  await w.clock.settle()
  await $.ui.focus({ requestId: 'thimble', component: 'Pane', element: `lb-name-${LABEL.id}`, origin: { kind: 'plugin', name: 'thimble' } } as never)
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Enter to rename · Esc to leave the field')
  // the actions stay where they are
  expect(await pane.find({ type: 'Button', key: 'lb-sample' })).toBeDefined()
  // the same name, or none, saves nothing
  await pane.input({ key: `lb-name-${LABEL.id}`, text: `  ${LABEL.name} ` })
  await w.clock.settle()
  expect(w.acts.some(a => a.kind === 'label')).toBe(false)
  label(w).name = 'fetch proxy links'
  await pane.input({ key: `lb-name-${LABEL.id}`, text: '  fetch   proxy links ' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label', payload: { label: LABEL.id, name: 'fetch proxy links' } })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect((await pane.find({ type: 'Input', key: `lb-name-${LABEL.id}` }))?.props).toMatchObject({ value: 'fetch proxy links' })
  await pane.unmount()
})
