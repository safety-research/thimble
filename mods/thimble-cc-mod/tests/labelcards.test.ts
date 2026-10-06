// Labels on cards: the label card the label tool writes (a bar card of the counts per value; its records live in the
// label panel), the label row of a card whose script read a label (its name a link with ↗), its marks in the values'
// colours, and the label panel's fixes (no card ids, words as written, retries in one dim line). `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { cardLayout, demojibake, labelHead, lineWidth, valueColour } from '../hooks/draw'
import type { CardData, Line } from '../hooks/draw'
import { validateCard } from '../hooks/lib'
import { COLORS, SERIES } from '../hooks/paint'

const CWD = '/corpus/wiki'
const text = (l: Line) => l.map(s => s.s).join('')

const LABEL_CARD: CardData = {
  id: 'lab123',
  kind: 'label',
  question: 'How many records get each value of "what the edit is for"?',
  x: 'value',
  y: 'records',
  note: 'All 2197 records of revisions.jsonl; a model read each record.',
  source: { script: '.thimble-cc-mod/scripts/label-what-the-edit-is-for.py', index: 0 },
  rows: [
    { label: 'research data links', value: 1734, group: '' },
    { label: 'own-page links', value: 443, group: '' },
    { label: 'other', value: 20, group: '' },
  ],
  total: 2197,
  label: { slug: 'what-the-edit-is-for', name: 'what the edit is for', kind: 'prompt', values: ['research data links', 'own-page links', 'other'], labeled: 2197, total: 2197, trial: false, paths: ['revisions.jsonl'] },
  examples: [
    { ref: 'revisions.jsonl#L10879', quote: 'County year twenty links direct filtered', note: '', value: 'research data links', why: 'All four links are jqp.vercel.app queries.', set: false, was: '' },
    { ref: 'revisions.jsonl#L10904', quote: 'Lieber Besucher, jedoch mÃ¶chten wir, dass du eintrÃ¤gst', note: '', value: 'own-page links', why: 'Only wiki.cgi links.', set: false, was: '' },
    { ref: 'revisions.jsonl#L10886', quote: 'CRITICALUPDATE2', note: '', value: 'other', why: 'A heading and a marker.', set: true, was: 'other' },
    { ref: 'revisions.jsonl#L11957', quote: 'Succ Query Force', note: '', value: 'research data links', why: 'md.succ.ai proxies.', set: true, was: 'own-page links' },
  ],
}

const USES: CardData = {
  id: 'use123',
  kind: 'bar',
  question: 'Which wikis get research data links?',
  x: 'wiki',
  y: 'edits',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 40, group: 'research data links' },
    { label: 'dse', value: 9, group: 'own-page links' },
    { label: 'probier', value: 3, group: 'other' },
  ],
  labels: [{ slug: 'what-the-edit-is-for', name: 'what the edit is for', values: ['research data links', 'own-page links', 'other'] }],
}

// ------------------------------------------------------------------------------------------------ drawing

test('a label value takes the categorical palette in the label\'s order; the last of two or more, the one outside the category, is dim', () => {
  const vs = ['research data links', 'own-page links', 'other']
  expect(vs.map(v => valueColour(vs, v))).toEqual([SERIES[0], SERIES[1], COLORS.dim])
  expect(valueColour(['only'], 'only')).toBe(SERIES[0])
  expect(valueColour(vs, 'nope')).toBeUndefined()
})

test('a label card is a bar card of its counts: bars in the values\' colours with counts and shares; its records are not on it', () => {
  const lay = cardLayout(LABEL_CARD, 96, -1)
  const lines = lay.lines.map(text)
  expect(lines[0]).toMatch(/^research data links +█+.* 1,734 +79%$/)
  expect(lay.lines[0]!.find(s => s.s.includes('█'))!.fg).toBe(SERIES[0])
  expect(lay.lines[2]!.find(s => /[█▏▎▍▌▋▊▉]/.test(s.s))!.fg).toBe(COLORS.dim)
  expect(lines).toContain('all  2,197')
  // a part of the whole: its bar on a track to the whole
  expect(lines[1]).toMatch(/█+[▏▎▍▌▋▊▉]?─+ +443/)
  // the records, their words and their controls are the label panel's
  const all = lines.join('\n')
  for (const gone of ['revisions.jsonl', 'County year', 'agree', 'disagree', 'why', '✓']) expect(all).not.toContain(gone)
  // items: the bars alone
  expect(lay.items.map(it => it.label)).toEqual(['research data links', 'own-page links', 'other'])
  expect(lay.hit(0, 1)).toBe(1)
  // the bar under the pointer turns the text colour, its label in inverse
  const lit = cardLayout(LABEL_CARD, 96, 1).lines[1]!
  expect(lit.find(s => s.s.includes('█'))!.fg).toBe(COLORS.text)
  expect(lit[0]).toMatchObject({ s: 'own-page links', inv: true })
})

test('at a reply\'s and a panel\'s widths a label card fits: nothing wider than its room', () => {
  for (const cols of [40, 56, 72, 96, 116]) for (const l of cardLayout(LABEL_CARD, cols, -1).lines) expect(lineWidth(l)).toBeLessThanOrEqual(cols)
})

test('a card that read a label shows it under its question: its name a link with ↗, then its values each after a dot in its colour', () => {
  const head = labelHead(USES, 96)
  expect(head.slugs).toEqual(['what-the-edit-is-for'])
  expect(text(head.lines[0]!)).toBe('label  what the edit is for ↗  ● research data links  ● own-page links  ● other')
  expect(head.lines[0]!.filter(s => s.s === '●').map(s => s.fg)).toEqual([SERIES[0], SERIES[1], COLORS.dim])
  // the name blue and underlined, a link to the label, and its ↗ blue; the values' words in the text colour
  const name = head.lines[0]!.find(s => s.s === 'what the edit is for')!
  expect(name).toMatchObject({ fg: COLORS.link, u: true })
  expect(name.b || name.inv).toBeFalsy()
  expect(head.lines[0]!.find(s => s.s === '↗')!.fg).toBe(COLORS.link)
  expect(head.lines[0]!.find(s => s.s === ' other')!.fg).toBeUndefined()
  // a press opens the label from the name and its ↗: those cells
  const row = text(head.lines[0]!)
  expect(row.slice(head.hots[0]!.x0, head.hots[0]!.x1)).toBe('what the edit is for ↗')
  // narrow: the values that do not fit are counted; hovered: the name and its ↗ in inverse
  const narrow = labelHead(USES, 56, 'what-the-edit-is-for')
  expect(text(narrow.lines[0]!)).toBe('label  what the edit is for ↗  ● research data links  +2')
  expect(narrow.lines[0]!.find(s => s.s === 'what the edit is for')).toMatchObject({ inv: true })
  expect(narrow.lines[0]!.find(s => s.s === '↗')).toMatchObject({ inv: true })
  // a label changed since the card was made says so
  expect(text(labelHead({ ...USES, labels: [{ ...USES.labels![0]!, stale: true }] }, 120).lines[0]!)).toMatch(/ {2}changed since$/)
  // a label card's row stops at the ↗: its bars name the values, and how it ran is the label panel's
  expect(text(labelHead(LABEL_CARD, 96).lines[0]!)).toBe('label  what the edit is for ↗')
  expect(labelHead({ ...USES, labels: undefined }, 96).lines).toEqual([])
  for (const cols of [30, 44, 60]) for (const l of labelHead(USES, cols).lines) expect(lineWidth(l)).toBeLessThanOrEqual(cols)
})

test('a card that read a label draws its marks in the values\' colours: bars by group, table cells, events and examples by their record', () => {
  const bars = cardLayout(USES, 80, -1)
  expect(bars.lines.slice(0, 3).map(l => l.find(s => /[█▏▎▍▌▋▊▉]/.test(s.s))!.fg)).toEqual([SERIES[0], SERIES[1], COLORS.dim])
  // without the label the same groups take the palette in their order
  expect(cardLayout({ ...USES, labels: undefined }, 80, -1).lines[2]!.find(s => /[█▏]/.test(s.s))!.fg).toBe(SERIES[2])
  const table: CardData = { ...USES, kind: 'table', columns: ['wiki', 'kind', 'edits'], rows: [['dse', 'research data links', 40], ['meta', 'own-page links', 9]] }
  const cells = cardLayout(table, 80, -1).lines.flat()
  // a value's word stays in the text colour: a table has no glyph to take the hue
  expect(cells.find(s => s.s.startsWith('research data links'))!.fg).toBeUndefined()
  expect(cells.find(s => s.s.startsWith('dse'))!.fg).toBeUndefined()
  const marks = { 'r.jsonl#L3': 'own-page links' }
  const timeline: CardData = { ...USES, kind: 'timeline', events: [{ time: '2026-06-18 10:00', label: 'An edit', ref: 'r.jsonl#L3' }, { time: '2026-06-18 11:00', label: 'Another', ref: 'r.jsonl#L9' }], labels: [{ ...USES.labels![0]!, marks }] }
  const tl = cardLayout(timeline, 80, -1).lines
  // an event the label does not mark: a dim mark
  expect(tl[0]!.filter(s => s.s === '●').map(s => s.fg)).toEqual([SERIES[1], COLORS.dim])
  // each event's row: its time at the content's edge, then its ● in its value's hue, or dim where the label marks it not
  expect(text(tl.find(l => text(l).includes('An edit'))!)).toMatch(/^18 Jun 10:00 {2}● An edit ↗$/)
  expect(tl.find(l => text(l).includes('An edit'))!.find(s => s.s === '●')!.fg).toBe(SERIES[1])
  expect(tl.find(l => text(l).includes('Another'))!.find(s => s.s === '●')!.fg).toBe(COLORS.dim)
  const example: CardData = { ...USES, kind: 'example', examples: [{ ref: 'r.jsonl#L3', quote: 'mÃ¶chten', note: 'a note' }], labels: [{ ...USES.labels![0]!, marks }] }
  const ex = cardLayout(example, 80, -1).lines
  expect(ex[0]![0]).toEqual({ s: '● ', fg: SERIES[1] })
  expect(ex.map(text).join('\n')).toContain('möchten')
})

test('demojibake: UTF-8 read as Windows-1252 back as written; text that reads right is kept', () => {
  expect(demojibake('jedoch mÃ¶chten wir, eintrÃ¤gst, GÃ¤steBuch')).toBe('jedoch möchten wir, einträgst, GästeBuch')
  expect(demojibake('itâ€™s â€œfineâ€\u009d ðŸ˜€')).toBe('it’s “fine” 😀')
  for (const s of ['NÃO São Paulo café naïve', 'plain', 'Ã']) expect(demojibake(s)).toBe(s)
})

test('validateCard holds a label card to its spec, and a card\'s labels to the helper\'s form', () => {
  expect(validateCard(LABEL_CARD, 'lab123')).toBeNull()
  expect(validateCard({ ...LABEL_CARD, label: undefined })).toBe('a label card needs its label: slug, name and values')
  expect(validateCard({ ...LABEL_CARD, examples: [{ ref: 'r#L1', quote: 'w', note: '', value: 'maybe' }] })).toBe('label card example 1 needs a ref, its words and one of the label\'s values')
  expect(validateCard({ ...LABEL_CARD, rows: [] })).toBe('a label card needs rows')
  expect(validateCard(USES)).toBeNull()
  expect(validateCard({ ...USES, labels: [{ name: 'x' }] })).toBe('labels must be a list of {slug, name, values, marks?}, as the card helper writes it')
})

// ------------------------------------------------------------------------------------------------ in a reply and the panel

type World = { files: Map<string, string>; opened: string[]; runs: string[][]; notes: string[] }

const SPEC = { name: 'what the edit is for', kind: 'prompt', definition: 'What the edit is for, from its links.', values: ['research data links', 'own-page links', 'other'], paths: ['revisions.jsonl'], field: 'body' }

function world(on: On): World {
  const w: World = {
    files: new Map([
      [`${CWD}/.thimble-cc-mod/cards/lab123.json`, JSON.stringify(LABEL_CARD)],
      [`${CWD}/.thimble-cc-mod/cards/use123.json`, JSON.stringify({ ...USES, created: '2026-10-05T10:00:00+00:00' })],
      [`${CWD}/.thimble-cc-mod/labels.json`, JSON.stringify([{ slug: 'what-the-edit-is-for', name: 'what the edit is for', updated: Date.parse('2026-10-05T11:00:00Z') / 1000 }])],
    ]),
    opened: [],
    runs: [],
    notes: [],
  }
  mock.env(on, {})
  mock.clock(on, { now: 1_790_000_000_000 })
  on('env.set', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\nguidance {{helper}}' }
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: w.files.get(e.path)!.length, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', ($, e) => ({
    value: [...w.files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }) as never)
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  const done = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const examples = (judged: boolean) =>
    LABEL_CARD.examples!.map(x => ({ value: x.value, ref: x.ref, text: x.quote, rationale: x.why, confidence: 1, analyst: x.set || (judged && x.ref.endsWith('L10879')), was: x.was || (judged && x.ref.endsWith('L10879') ? 'research data links' : '') }))
  on('process.run', ($, e) => {
    const argv = e.argv as string[]
    if (String(argv[1]).endsWith('labels.py')) {
      w.runs.push(argv.slice(2))
      const base = { slug: 'what-the-edit-is-for', name: SPEC.name, kind: 'prompt', values: SPEC.values, counts: { 'research data links': 1734, 'own-page links': 443, other: 20 }, labeled: 2197, total: 2197, trial: false, errors: [], status: '13 empty replies split and asked again', cards: ['lab123'] }
      if (argv[2] === 'show') return done(JSON.stringify({ ...base, examples: examples(false), spec: SPEC }))
      if (argv[2] === 'verdict') {
        // the helper writes the card again, the record judged
        const card = { ...LABEL_CARD, examples: LABEL_CARD.examples!.map(x => (x.ref === argv[4] ? { ...x, set: true, was: x.value, value: argv[5]! } : x)) }
        w.files.set(`${CWD}/.thimble-cc-mod/cards/lab123.json`, JSON.stringify(card))
        return done(JSON.stringify({ ...base, examples: examples(true) }))
      }
    }
    const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
    return done(JSON.stringify(req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'card', status: 'ok', why: 'resolves', window: [] }))))
  })
  on('prompt.read', () => ({ text: '', cursor: 0 }) as never)
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

type M = Mounted<'terminal'>
const MESSAGE = (body: string) =>
  ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 60 }, props: { text: body, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 140, rows: 60 }, props: { bodyColumns: 96, bodyRows: 56 } } as never

/** Every string a drawn tree shows (a Button's label too), joined. */
function shown(tree: unknown): string {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { label?: unknown; children?: unknown; props?: { label?: unknown; children?: unknown } }
      const label = o.label ?? o.props?.label
      if (typeof label === 'string') out.push(label)
      walk(o.children ?? o.props?.children)
    }
  }
  walk(tree)
  return out.join('\n')
}

test('in a reply a label card is a bar card with its label row; a press on the label\'s name opens the label panel', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:lab123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 50, in: 'card-1-lab123' })
  const before = shown(await ui.drawn({ in: 'card-1-lab123' }))
  expect(before).toContain('label  \nwhat the edit is for\n \n↗')
  for (const gone of ['agree', 'disagree', 'a model read each record', 'County year']) expect(before).not.toContain(gone)
  // the top border, the title and the blank row under it, then the label row; its name after the border, the padding
  // and "label  "
  await ui.pointer({ type: 'down', x: 2 + 7 + 3, y: 3, button: 'left', in: 'card-1-lab123' } as never)
  await ui.pointer({ type: 'up', x: 2 + 7 + 3, y: 3, button: 'left', in: 'card-1-lab123' } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  expect(w.runs).toContainEqual(['show', 'what-the-edit-is-for', '--cwd', CWD])
})

test('a press on a card\'s label line opens the label in the panel: no card id, the record\'s words as written, the retries in one line', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:use123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 20, in: 'card-1-use123' })
  const card = shown(await ui.drawn({ in: 'card-1-use123' }))
  expect(card).toContain('label  ')
  expect(card).toContain('what the edit is for')
  // the label changed after the card was made
  expect(card).toContain('changed since')
  // the label row under the top border, the title and the blank row; its name past the border, the padding and "label  "
  await ui.pointer({ type: 'down', x: 12, y: 3, button: 'right', in: 'card-1-use123' } as never)
  await ui.pointer({ type: 'up', x: 12, y: 3, button: 'right', in: 'card-1-use123' } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  let pane = (await $.ui.mount(PANE)) as unknown as M
  // the examples and the cards are folded until opened (e, c)
  const folded = shown(await pane.drawn())
  expect(folded).toContain('what the edit is for')
  expect(folded).not.toContain('jedoch möchten wir')
  expect(folded).not.toContain(LABEL_CARD.question)
  await pane.press({ key: 'hk-examples' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'hk-cards' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const panel = shown(await pane.drawn())
  expect(panel).toContain('what the edit is for')
  expect(panel).toContain('13 empty replies split and asked again')
  expect(panel).toContain('jedoch möchten wir')
  expect(panel).not.toContain('mÃ¶')
  expect(panel).toContain(LABEL_CARD.question)
  expect(panel).not.toMatch(/card:lab123|lab123/)
  expect(panel).toContain('agree')
  expect(panel).toContain('✓ set by you')
  await pane.unmount()
})
