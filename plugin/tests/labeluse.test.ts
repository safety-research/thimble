// The label rows under a card and under an answer, and the ask before a large label run (labels/use.ts): the labels a
// turn's `thimble label` commands ran show under the card drawn after them, in the colors the card gives their values
// (a plain dim dot where it gives none), and under the answer only those no card of it shows, in the label's own
// colors; Claude reads a large label run's ask after its command and asks the person with Claude Code's question tool,
// their answer there runs as the person and Claude reads what it started; a feed line read again never brings an
// answered ask back. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { colorOf } from '../labels/pane'
import { answerAsk, labelAskFromFeed, labelAskNow, labelRowEl, labelsUnderAnswer, labelsUnderCard, needLabelList, resetLabelUse } from '../labels/use'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const el = (type: string) => (props: Any) => ({ type, props })
const ELS = { Box: el('Box'), Text: el('Text'), Button: el('Button') }
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  return out
}
/** Each value's press under a row: the dot's color (or dim) and its value. */
function dots(row: Any): { value: string; color?: string; dim?: boolean }[] {
  return all(row).filter(k => k.type === 'Button' && /that are/.test(k.props.label)).map(b => ({
    value: b.props.label.replace(/^.* that are /, ''),
    ...(b.props.children[0].props.color ? { color: b.props.children[0].props.color } : {}),
    ...(b.props.children[0].props.dimColor ? { dim: true } : {}),
  }))
}

/** An engine that keeps versioned state in memory; `ran` holds each `thimble` command, `kernel` answers it. */
function engine(kernel: (args: string[]) => { code?: number; out: unknown } = () => ({ out: [] })) {
  resetLabelUse()
  const state = new Map<string, { value: unknown; version: number }>()
  const later: (() => unknown)[] = []
  const ran: string[][] = []
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', THIMBLE_ROOT: '/made-up/data', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-labeluse', cwd: async () => '/made-up/data', messages: async () => [] },
    fs: { read: async () => { throw new Error('no file') }, write: async () => undefined, exists: async () => false, list: async () => [] },
    process: {
      run: async (argv: string[]) => {
        const args = argv.slice(1)
        ran.push(args)
        const r = kernel(args)
        return { exitCode: r.code ?? 0, stdout: typeof r.out === 'string' ? r.out : JSON.stringify(r.out), stderr: '' }
      },
    },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, o?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (o?.ifVersion !== undefined && o.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => 1000, after: (_ms: number, fn: () => unknown) => { later.push(fn); return { cancel() {} } } },
    ui: { invalidate: () => undefined },
  }
  /** Run what waits on the clock, and let its reads come back. */
  const flush = async () => {
    while (later.length) await later.shift()!()
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0))
  }
  const set = (key: string, value: unknown, id?: string) => $.state.set({ plugin: 'thimble', key, ...(id ? { id } : {}) }, value)
  return { $, ran, flush, set, state }
}

test('several labels: one row each, `labels` once, the names, how each was made and the counts padded so the values line up', () => {
  const used = [
    { name: 'sabotage_candidate', kind: 'regex', values: ['yes', 'no'], records: 20764 },
    { name: 'flag', kind: 'code', values: ['yes', 'no'], records: 412 },
  ]
  const row = labelRowEl(ELS, used, { key: 'k', onOpen: () => undefined })
  const rows = (row.props.children as Any[]).filter(n => n.type === 'Box')
  expect(row.props.flexDirection).toBe('column')
  expect(rows.map(textOf)).toEqual([
    'labels  sabotage_candidate · regex · 20,764 records  ● yes  ● no',
    '        flag               · code  ·    412 records  ● yes  ● no',
  ])
})

test('the word label never sits alone on its row: it is one item with the name it names, which does not shrink', () => {
  const row = labelRowEl(ELS, [{ name: 'colluding', kind: 'prompt', values: ['yes', 'no'], records: 1286 }], { key: 'k', onOpen: () => undefined })
  // the first item is the label's row, not the word alone
  const first = (row.props.children as Any[])[0]
  expect(first.type).toBe('Box')
  // inside the group, the word and the name are one item that keeps them on one row
  const word = first.props.children[0].props.children[0]
  expect(word.props).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
  expect(word.props.flexWrap).toBeUndefined()
  expect(textOf(word)).toBe('label colluding')
})

test('a row too long for the width wraps its values in their own column, under its first value, never under `labels`', () => {
  const values = ['proxy_fetch', 'coordination', 'external_links', 'no_links', 'wiki_links_only', 'other']
  const row = labelRowEl(ELS, [{ name: 'edit_purpose', kind: 'code', values, records: 14591 }], { key: 'k', onOpen: () => undefined })
  const [head, vals] = (row.props.children as Any[])[0].props.children
  // the name, how it was made and the count keep their width; only the values' column shrinks and wraps
  expect(head.props).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
  expect(vals.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1 })
  expect(textOf(head)).toBe('label edit_purpose · code · 14,591 records')
  // each value is one item with the gap before it, so a wrap never splits a dot from its value
  expect((vals.props.children as Any[]).every(v => v.type === 'Box' && v.props.flexShrink === 0)).toBe(true)
})

test('a card shows the labels its turn ran before it; the answer only those no card of it shows; a press opens the label', async () => {
  const LIST = [
    { name: 'spam', kind: 'prompt', values: ['yes', 'no'], records: 420 },
    { name: 'tone', kind: 'code', values: ['calm', 'angry'], records: 6 },
  ]
  const w = engine(args => (args[0] === 'label' && args[1] === '--json' ? { out: LIST } : { out: {} }))
  const card = 'c00000000000a1'
  await w.set('answerTurns', ['t1'])
  await w.set('answerTurn', {
    turnId: 't1', n: 1, prompt: { text: 'Which messages are spam?', by: 'composer', row: 'p1' }, rows: ['r1', 'r2'], answer: 'r2', reason: 'answer',
    startedAt: 1, endedAt: 2, seq: 3,
    labels: [{ name: 'spam', args: [], toolUseId: 'b1', seq: 1, ok: true }, { name: 'tone', args: [], toolUseId: 'b2', seq: 3, ok: true }],
    cards: [{ id: card, toolUseId: 'k1', seq: 2 }],
  }, 't1')
  await w.set('answerRowTurn', 't1', 'r1')
  await w.set('answerRowTurn', 't1', 'r2')
  await w.set('card', { id: card, version: 1, title: 'Spam by agent', calls: {} }, card)
  // the card names `yes` in a color of its own in its legend, and `no` in none
  await w.set('cardTree', { gen: 1, width: 60, seq: 1, tree: { t: 'Box', c: [{ t: 'Text', p: { color: '#b2c24f' }, c: ['■'] }, { t: 'Text', c: [' yes  no'] }] } }, card)
  // a drawing reads nothing: the labels are read from a hook (the session's start, a turn's end, a label command)
  expect(await labelsUnderCard(w.$, ELS, card, 80)).toEqual([])
  await w.flush()
  expect(w.ran).toEqual([])
  needLabelList(w.$)
  await w.flush()
  const under = await labelsUnderCard(w.$, ELS, card, 80)
  expect(textOf(under)).toBe('label spam · read by Claude · 420 records  ● yes  ● no')
  // each dot in its value's color: the card's where it gives one, else the label's own (the labels pane's), never
  // one gray for every value
  expect(dots(under)).toEqual([{ value: 'yes', color: '#b2c24f' }, { value: 'no', color: colorOf(['yes', 'no'], 'no') }])
  const answer = await labelsUnderAnswer(w.$, ELS, 'r2', 80)
  expect(textOf(answer)).toBe('label tone · code · 6 records  ● calm  ● angry')
  // a row that is not the turn's answer gets none
  expect(await labelsUnderAnswer(w.$, ELS, 'r1', 80)).toEqual([])
  // the read ran once, as the person's (`thimble label --json`)
  expect(w.ran.filter(a => a.join(' ') === 'label --json').length).toBe(1)
  // a press on the label's name opens the labels pane on it, the open made inside the press (what the press returns
  // settles after it): Claude Code places the pane at any width only for such an open
  const opens: Any[] = []
  w.$.ui.open = (a: Any) => new Promise(r => setTimeout(() => r((opens.push(a.id), { isPlaced: true })), 1))
  w.$.ui.panes = async () => []
  const name = all(answer).find(k => k.type === 'Button' && k.props.label === 'open the label tone')
  const pressed = name.props.onPress()
  expect(pressed).toBeInstanceOf(Promise)
  await pressed
  expect(opens).toEqual(['thimble'])
})

test("a card names only the labels its drawing shows; the turn's other labels go under the answer", async () => {
  const LIST = [
    { name: 'topic', kind: 'code', values: ['OECD equity', 'grocery stores', 'other'], records: 40 },
    { name: 'asks', kind: 'regex', values: ['yes', 'no'], records: 40 },
    { name: 'tactic', kind: 'regex', values: ['yes', 'no'], records: 40 },
  ]
  const w = engine(args => (args[0] === 'label' && args[1] === '--json' ? { out: LIST } : { out: {} }))
  const [a, b] = ['c00000000000c1', 'c00000000000c2']
  await w.set('answerTurns', ['t1'])
  await w.set('answerTurn', {
    turnId: 't1', n: 1, rows: ['r1'], answer: 'r1', reason: 'answer', startedAt: 1, endedAt: 2, seq: 5,
    labels: ['topic', 'asks', 'tactic'].map((name, i) => ({ name, args: [], toolUseId: `b${i}`, seq: i + 1, ok: true })),
    cards: [{ id: a, toolUseId: 'k1', seq: 4 }, { id: b, toolUseId: 'k2', seq: 5 }],
  }, 't1')
  await w.set('answerRowTurn', 't1', 'r1')
  await w.set('card', { id: a, version: 1, title: 'Posts by topic', calls: {} }, a)
  await w.set('card', { id: b, version: 1, title: 'One task', calls: {} }, b)
  // card a draws a topic's value, in no color of its own and with a plain "yes" beside it; card b draws none
  await w.set('cardTree', { gen: 1, width: 60, seq: 1, tree: { t: 'Box', c: [{ t: 'Text', c: ['OECD equity 12 · yes 3'] }] } }, a)
  await w.set('cardTree', { gen: 1, width: 60, seq: 1, tree: { t: 'Box', c: [{ t: 'Text', c: ['R1 window 5m39s'] }] } }, b)
  needLabelList(w.$)
  await w.flush()
  expect(textOf(await labelsUnderCard(w.$, ELS, a, 80))).toBe('label topic · code · 40 records  ● OECD equity  ● grocery stores  ● other')
  expect(await labelsUnderCard(w.$, ELS, b, 80)).toEqual([])
  const answer = textOf(await labelsUnderAnswer(w.$, ELS, 'r1', 80))
  expect(answer).toContain('asks')
  expect(answer).toContain('tactic')
  expect(answer).not.toContain('topic ')
})

test('a read that fails keeps the rows as last read; a read asked while one runs reads once more after it', async () => {
  const LIST = [{ name: 'spam', kind: 'regex', values: ['yes', 'no'], records: 12 }]
  let fail = false
  const w = engine(args => (args[0] === 'label' && args[1] === '--json' ? (fail ? { code: 1, out: 'thimble label: a made-up failure' } : { out: LIST }) : { out: {} }))
  const card = 'c00000000000b2'
  await w.set('answerTurns', ['t1'])
  await w.set('answerTurn', { turnId: 't1', n: 1, rows: ['r1'], answer: 'r1', reason: 'answer', startedAt: 1, endedAt: 2, seq: 2, labels: [{ name: 'spam', args: [], toolUseId: 'b1', seq: 1, ok: true }], cards: [{ id: card, toolUseId: 'k1', seq: 2 }] }, 't1')
  await w.set('card', { id: card, version: 1, title: 'Spam', calls: {} }, card)
  await w.set('cardTree', { gen: 1, width: 60, seq: 1, tree: { t: 'Box', c: [{ t: 'Text', c: ['spam by agent'] }] } }, card)
  needLabelList(w.$)
  await w.flush()
  expect(textOf(await labelsUnderCard(w.$, ELS, card, 80))).toBe('label spam · regex · 12 records  ● yes  ● no')
  fail = true
  needLabelList(w.$)
  await w.flush()
  expect(textOf(await labelsUnderCard(w.$, ELS, card, 80))).toBe('label spam · regex · 12 records  ● yes  ● no')
  // two hooks ask while a read runs: one more read after it, not two
  fail = false
  const before = w.ran.length
  needLabelList(w.$)
  needLabelList(w.$)
  needLabelList(w.$)
  await w.flush()
  expect(w.ran.length - before).toBe(2)
})

test("a `thimble label` command of Claude's reads the labels again from its hook; any other command does not", async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const reads: string[][] = []
  on('session.id', () => ({ value: 's-labeluse' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', () => ({ value: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('env.set', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    if (e.argv.slice(1).join(' ') === 'label --json') reads.push(e.argv)
    const out = e.argv.slice(1).join(' ') === 'label --json' ? '[{"name": "spam", "values": ["yes", "no"]}]' : '{}'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('tool.call', () => ({ result: '' }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(100)
  const n = reads.length
  expect(n).toBeGreaterThan(0)
  await $.tool.call({ tool: 'Bash', command: 'ls runs' } as never)
  await clock.advance(100)
  expect(reads.length).toBe(n)
  await $.tool.call({ tool: 'Bash', command: 'thimble label spam --in chat.jsonl --regex "(?i)buy now"' } as never)
  await clock.advance(100)
  expect(reads.length).toBe(n + 1)
})

test("a large label run: Claude reads the ask after its command, as the question tool's input; the person's answer there runs as the person, and Claude reads what it started", async ($, on) => {
  resetLabelUse()
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const ran: string[][] = []
  const ev = { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, calls: 9, sample: 300, text: 'Read 420 records of chat.jsonl with Claude', meta: '9 model calls', t: 1 }
  // the kernel's change feed: the ask's line, once Claude's command wrote it
  let feed = ''
  const isFeed = (path: string) => /\/events\/[^/]+\.jsonl$/.test(path)
  on('session.id', () => ({ value: 's-labeluse' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: isFeed(e.path) ? feed : '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_$: unknown, e: { path: string }) => ({ value: isFeed(e.path) ? { kind: 'file', size: new TextEncoder().encode(feed).length, mtimeMs: 0, isLink: false } : { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('env.set', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv.slice(1))
    const out = e.argv.includes('--answer') ? '{"name": "spam", "choice": "sample", "reads": 300, "of": 420, "waiting": 300}' : '[]'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  // the kernel writes the ask's line in the feed while Claude's command runs
  on('tool.call', async (_$: unknown, e: Any) => {
    if (e.tool === 'Bash' && /--prompt/.test(e.command)) feed += `${JSON.stringify(ev)}\n`
    if (e.tool === 'AskUserQuestion') return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Run on a sample of 300' } } } as never
    return { result: 'Not started' } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(100)
  // the command that made the ask: Claude reads the question to ask, with each choice's cost
  const r = await $.tool.call({ tool: 'Bash', command: 'thimble label spam --in chat.jsonl --prompt "The message is spam."' } as never) as Any
  const told = String((r.context ?? []).join('\n'))
  expect(told).toContain('Ask them now with AskUserQuestion')
  const input = JSON.parse(told.slice(told.indexOf('{')))
  expect(input.questions[0].question).toBe('Read 420 records of chat.jsonl with Claude for the label spam?')
  expect(input.questions[0].options).toEqual([
    { label: 'Run all', description: '9 calls to Claude Sonnet 5.5, about 20 s' },
    { label: 'Run on a sample of 300', description: '7 calls to Claude Sonnet 5.5, about 10 s' },
    { label: 'Cancel', description: 'reads none' },
  ])
  // the person answers Claude's question: their choice runs as their own command, and Claude reads what it started
  const answered = await $.tool.call({ tool: 'AskUserQuestion', ...input } as never) as Any
  expect(ran.find(a => a.includes('--answer'))).toEqual(['label', 'spam', '--answer', 'sample', '--ask', 'a1'])
  const note = String((answered.context ?? []).join('\n'))
  expect(note).toContain('random sample of 300 of the label spam\'s 420 records')
  expect(note).toContain('`thimble label spam --wait` waits for them and prints the label\'s counts')
  // Claude runs the label again, a new ask for the rest; a question of Claude's about something else runs no choice
  feed += `${JSON.stringify({ ...ev, ask: 'a2', units: 120, sample: 0, rest: true })}\n`
  await $.tool.call({ tool: 'Bash', command: 'thimble label spam' } as never)
  const n = ran.length
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which file first?', header: 'File', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] } as never)
  expect(ran.slice(n).some(a => a.includes('--answer'))).toBe(false)
})

test('a choice the kernel refuses shows the failure line, and Claude reads that it did not run', async () => {
  const w = engine(args => (args.includes('--answer') ? { code: 1, out: 'thimble label: the label changed since it asked' } : { out: {} }))
  await labelAskFromFeed(w.$, { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, sample: 300, t: 1 })
  const said = await answerAsk(w.$, 'all')
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
  const fail = w.state.get(JSON.stringify({ plugin: 'thimble', key: 'failLine' }))?.value as Any
  const line = fail ?? [...w.state.values()].map(v => v.value as Any).find(v => v && typeof v === 'object' && v.kind === 'failed')
  expect(line?.text).toBe('× The label spam did not start: the label changed since it asked. Ask Claude to run it again.')
  expect(said).toContain('did not run: the label changed since it asked')
})
