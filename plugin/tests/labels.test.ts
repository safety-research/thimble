// A --prompt label's reads in a session (labels/labels.ts): the `label` line Claude's command wrote in the change feed
// starts the model's reads beside the session, the bar's busy line names the label while they run, Claude hears the
// counts with the next prompt, and a call that failed shows the failure line in the person's words. The kernel and the
// model are stand-ins; all data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { paneNow } from '../core/pane'
import { rerunLabel } from '../labels/edit'
import { drawLabels, labelEdit, openLabels } from '../labels/pane'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FEED = '/made-up/th/events/s-label.jsonl'
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
const UNITS = [{ ref: 'chat.jsonl#L1', text: 'Sorry, my mistake.' }, { ref: 'chat.jsonl#L2', text: 'Merged.' }]

/** A session over a made-up folder whose `thimble` is a stand-in: one wave of two records, then nothing waits. */
function world(on: Any, reply: () => Promise<Any>) {
  mock.env(on, { THIMBLE_HOME: '/made-up/th', HOME: '/made-up/home', PATH: '/usr/bin', TMPDIR: '/made-up/tmp' })
  const clock = mock.clock(on, { now: 0 })
  const session = mock.session(on)
  const w = { feed: '', answers: [] as Any[], context: [] as string[] }
  let waited = false
  on('session.id', () => ({ value: 's-label' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.stat', (_$: unknown, e: { path: string }) => ({ value: e.path === FEED ? { kind: 'file', size: w.feed.length, mtimeMs: 0, isLink: false } : { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path === FEED ? w.feed : promptStub(e.path) ?? '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('model.complete', async () => ({ value: await reply() }))
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const a = e.argv
    const folders = tempRun(a)
    if (folders) return { value: { ...folders, isStdoutTruncated: false, isStderrTruncated: false } }
    const ok = (out: unknown) => ({ value: { exitCode: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'tail') return ok(w.feed.slice(Number(a[2]!.slice(1)) - 1))
    if (a.includes('--waiting')) {
      const units = waited ? [] : UNITS
      waited = true
      return ok({ name: 'apology', definition: 'The message apologizes.', values: ['yes', 'no'], reason: false, units, waiting: units.length, batches: units.length ? [units.map(u => u.ref)] : [] })
    }
    if (a.includes('--answers')) {
      const p = JSON.parse(e.init?.stdin || '{}')
      if (!a.includes('--json')) return ok('')
      w.answers.push(p)
      const values = Object.values(p.values || {}).map((v: Any) => v.value)
      const failed = Object.keys(p.failed || {}).length
      return ok({ records: 2, valued: values.length, waiting: 0, failed, counts: Object.fromEntries(['yes', 'no'].map(v => [v, values.filter(x => x === v).length]).filter(([, k]) => k)) })
    }
    return ok('{}')
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('tool.call', () => ({ result: '' }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string; context?: string[] }) => { w.context.push(...(e.context ?? [])); return { text: e.text } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  return { w, clock, session }
}

/** Claude runs `thimble label apology --prompt …`: the kernel writes its `label` line in the feed. */
async function claudeLabels($: Any, w: Any): Promise<void> {
  w.feed += `${JSON.stringify({ t: 1, session: 's-label', root: '/made-up/data', kind: 'label', name: 'apology' })}\n`
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --in chat.jsonl --prompt "The message apologizes."' } as never)
}

test('a label line starts the reads: the busy line names the label, and Claude hears the counts with the next prompt', async ($, on) => {
  let answer: (v: Any) => void = () => undefined
  const { w, clock } = world(on, () => new Promise(resolve => { answer = resolve }))
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await claudeLabels($, w)
  await clock.advance(500)
  // the model's call is out: the bar names the step
  expect(textOf(await $.ui.render(BAND))).toContain('labeling apology')
  answer({ isAnswered: true, text: JSON.stringify([{ i: 1, value: 'yes', confidence: 0.9 }, { i: 2, value: 'no', confidence: 0.8 }]) })
  await clock.advance(500)
  expect(w.answers[0].values).toEqual({ 'chat.jsonl#L1': { value: 'yes', confidence: 0.9 }, 'chat.jsonl#L2': { value: 'no', confidence: 0.8 } })
  expect(textOf(await $.ui.render(BAND))).not.toContain('labeling apology')
  expect(textOf(await $.ui.render(BAND))).not.toContain('× ')
  // the next prompt carries what the reads gave, as context beside it that the person does not see
  await $.prompt.submit({ text: 'How many apologized?', origin: { kind: 'composer' } } as never)
  const told = w.context.join('\n')
  expect(told).toContain("thimble's report")
  expect(told).toContain('The model finished reading the records of the label apology (1 call). apology: 2 of 2 records have a value (1 yes, 1 no).')
})

test("a label changed in the pane is applied again by Claude's command, its reads start, and Claude hears what changed", async () => {
  const ran: string[][] = []
  const state = new Map<string, unknown>()
  let person = ''
  let started = 0
  const PERSON = '/made-up/th/events/person-s-edit.jsonl'
  const $ = {
    env: { get: async (name: string) => ({ THIMBLE_HOME: '/made-up/th' } as Any)[name] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-edit', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    fs: { exists: async () => false, stat: async (p: string) => (p === PERSON ? { kind: 'file', size: person.length } : { kind: 'other', size: 0 }), read: async (p: string) => (p === PERSON ? person : '') },
    state: { get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }), set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } } },
    ui: { invalidate: () => undefined, toast: () => undefined },
    // the reads are asked for (labels.ts labelFromFeed), and wait: a moment later never comes
    clock: { after: () => { started++; return { cancel() {} } } },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        const out = (o: unknown) => ({ exitCode: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '' })
        if (argv[0] === 'tail') return out(person.slice(Number(argv[2]!.slice(1)) - 1))
        person += `${JSON.stringify({ t: 2, session: 'person-s-edit', root: '/made-up/data', kind: 'label', name: 'apology' })}\n`
        return out({ name: 'apology', records: 2, valued: 0, waiting: 2, failed: 0, counts: {} })
      },
    },
  } as Any
  const label = { name: 'apology', kind: 'prompt', rule: 'The message apologizes.', values: ['yes', 'no'], in: 'chat.jsonl', model: null, limit: null, seed: 0 }
  expect(await rerunLabel($, '/made-up/data', label, { model: 'opus' })).toBe(null)
  const cmd = ran.find(a => a[0]!.endsWith('/bin/thimble'))!
  expect(cmd.slice(1)).toEqual(['label', 'apology', '--in', 'chat.jsonl', '--prompt', 'The message apologizes.', '--values', 'yes,no', '--model', 'opus', '--json'])
  // the line it wrote in the person's feed was read and acted on, as Claude's are: the reads were asked for
  expect(started).toBe(1)
  // Claude hears what changed with the next prompt
  expect(JSON.stringify([...state.values()])).toContain('The analyst changed the model of the label apology in the labels pane and applied it again')
})

const HEAD = { name: 'sorry', kind: 'regex', rule: '(?i)sorry|apolog', values: ['yes', 'no'], in: 'chat.jsonl', records: 3, valued: 3, waiting: 0, failed: 0, checked: 0, agree: 0, disagree: 0, counts: { yes: 2, no: 1 } }

/** The pane's elements as plain nodes, so a test reads the tree and presses its Buttons. */
const ELS = Object.fromEntries(['Box', 'Text', 'Button', 'Code'].map(t => [t, (props: Any) => ({ type: t, props })]))
const nodes = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)])
const words = (n: Any): string => (n == null || n === false ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(words).join('') : n.props?.source ?? n.props?.label ?? words(n.props?.children))

/** An engine for the pane alone: its state, and a `thimble` that answers as the kernel would for a made-up folder. */
function paneEngine(ran: string[][], many = 0): Any {
  const state = new Map<string, unknown>()
  let checked = false
  return {
    env: { get: async (name: string) => ({ THIMBLE_HOME: '/made-up/th', THIMBLE_ROOT: '/made-up/data' } as Any)[name] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-pane', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    fs: { exists: async () => false, stat: async () => ({ kind: 'dir' }) },
    state: { get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }), set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } } },
    ui: { open: async () => ({ isPlaced: true }), toast: () => undefined },
    // what runs a moment later runs at once; a wait never ends, so a drawing waits for its kernel answer
    clock: { after: (ms: number, fn: () => void) => { if (!ms) void Promise.resolve().then(fn); return { cancel() {} } } },
    process: {
      run: async (argv: string[]) => {
        const a = argv.slice(1)
        ran.push(a)
        const head = checked ? { ...HEAD, checked: 1, disagree: 1, counts: { yes: 1, no: 2 } } : HEAD
        const l1 = { ref: 'chat.jsonl#L1', i: 0, value: 'yes', by: 'regex', words: "I'm sorry, I broke the build.", meta: 'wren', hit: { before: "I'm ", match: 'sorry', after: ', I broke the build.' } }
        const l3 = { ref: 'chat.jsonl#L3', i: 1, value: 'yes', by: 'regex', words: 'Apologies for the noise.', meta: 'moss' }
        const out = a.includes('--check') ? { ref: a[3], was: 'yes', now: a[4], ...head, checked: 1, agree: 0, changed: [{ ref: a[3], was: 'yes', now: a[4] }] }
          : a.includes('--records') && many ? { label: head, value: a[3], at: Number(a[5]), total: many, records: Array.from({ length: Math.max(0, Math.min(Number(a[7]), many - Number(a[5]))) }, (_, i) => ({ ...l3, ref: `chat.jsonl#L${Number(a[5]) + i + 1}`, i: Number(a[5]) + i })) }
          : a.includes('--records') ? { label: head, value: a[3], at: 0, total: checked ? 1 : 2, records: checked ? [l3] : [l1, l3] }
            : [head, { ...HEAD, name: 'long', kind: 'code', rule: 'def label(unit):\n    return len(unit["text"]) > 30' }]
        if (a.includes('--check')) checked = true
        return { exitCode: 0, stdout: JSON.stringify(out), stderr: '' }
      },
    },
  }
}

/** The pane drawn at `W` columns: its nodes, and its rows as text (a key Button as Claude Code draws it: `j: next`). */
async function drawn($: Any, W = 90, H = 40) {
  const top = await drawLabels($, { props: { bodyColumns: W, scroll: { bodyRows: H } } }, (await paneNow($))?.args, ELS) as Any
  const tree = nodes(top)
  const shown = (n: Any): string => (n == null || n === false ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(shown).join('')
    : n.type === 'Button' && n.props.hotkey ? `${n.props.hotkey}: ${shown(n.props.children) || n.props.label}` : n.props?.source ?? shown(n.props?.children))
  const rows = tree.filter(n => /^(r\d+|head)$/.test(String(n.props?.key))).map(shown)
  const press = (hotkey: string) => tree.find(n => n.type === 'Button' && n.props.hotkey === hotkey).props.onPress()
  const keys = tree.filter(n => n.type === 'Button' && n.props.hotkey).map(n => n.props.hotkey)
  return { top, tree, rows, press, keys }
}

test('the labels pane: a table per label; n opens the first value, j picks its first example, a number key checks it', async () => {
  const ran: string[][] = []
  const $ = paneEngine(ran)
  await openLabels($)
  // at rest: each label a table of its values, the same keys as in every state, no number key
  let d = await drawn($)
  expect(d.rows[0]).toBe('Labels · 2 labels')
  expect(d.rows.some(r => /^sorry +3$/.test(r))).toBe(true)
  expect(d.rows.some(r => /^ {2}yes +▅+ +2 +67%$/.test(r))).toBe(true)
  // under each name its definition in short: plain words, no press, so nothing turns inverse under the pointer
  expect(d.rows).toContain('regex: (?i)sorry|apolog')
  expect(d.tree.some(n => n.type === 'Button' && words(n).startsWith('regex: '))).toBe(false)
  expect(d.keys).toEqual(['p', 'n', 'k', 'j'])
  // the keys' row: under the pointer a key's words brighten, never Claude Code's inverse of a plain Button
  const keyRow = d.tree.filter(n => n.type === 'Button' && /^key-/.test(String(n.props.key)))
  expect(keyRow.length).toBeGreaterThan(0)
  expect(keyRow.every(n => n.props.hover?.inverse === false)).toBe(true)
  await d.press('n')
  // the first value open: the label alone under its name, its examples one line each; every key in the one row above
  // the input, e to edit its rule and b back to all the labels among them
  d = await drawn($)
  expect(d.rows[0]).toBe('Labels › sorry')
  expect(d.rows.some(r => /^▸ yes +▅+ +2 +67%$/.test(r))).toBe(true)
  expect(d.rows.some(r => r.startsWith('long'))).toBe(false)
  expect(d.rows.some(r => /^ {2}wren {2}I'm sorry, I broke the build\.$/.test(r))).toBe(true)
  expect(d.keys).toEqual(['d', 'p', 'n', 'k', 'j', 'e', 'b'])
  await d.press('j')
  // the first example picked: open in place, where it is, and the check keys
  d = await drawn($)
  expect(d.rows.some(r => /^▸ wren {2}I'm sorry, I broke the build\.$/.test(r))).toBe(true)
  expect(d.rows.some(r => /^ {8}chat\.jsonl:1 +1: yes {2}2: no$/.test(r))).toBe(true)
  expect(d.keys).toEqual(['1', '2', 'd', 'p', 'n', 'k', 'j', 'e', 'b'])
  // 2 (no) is the person's check of the picked example; the next one is picked
  await d.tree.find(n => n.type === 'Button' && n.props.hotkey === '2' && n.props.label === 'no').props.onPress()
  expect(ran.find(a => a.includes('--check'))).toEqual(['label', 'sorry', '--check', 'chat.jsonl#L1', 'no', '--json'])
  d = await drawn($)
  expect(d.rows.some(r => /^▸ moss {2}Apologies for the noise\.$/.test(r))).toBe(true)
  expect(d.rows.some(r => /^ {2}no +▅+ +2 +67%$/.test(r))).toBe(true)
  // Claude hears the label's checks with the next prompt
  expect(Object.values((await $.state.get({ plugin: 'thimble', key: 'tell' })).value)).toEqual(['The analyst checked records of the label sorry in the labels pane. It now holds 1 check: 0 agree with the label and 1 changed a value: chat.jsonl#L1 (the label gave yes, the analyst says no). The checks count in place of the label\'s values; `thimble label sorry` prints the counts now.'])
})

test('the labels pane: d switches a label between its examples and its definition, esc and b go back to all the labels, a press opens a value and closes it', async () => {
  const ran: string[][] = []
  const $ = paneEngine(ran)
  await openLabels($, { label: 'long' })
  let d = await drawn($)
  // opened on the label itself: all the labels stand under it on the trail, so esc goes back to them, never to it
  expect((await paneNow($))?.trail?.at(-1)).toEqual({ kind: 'labels', args: {}, title: 'Labels' })
  // a code label: no e (its code is no one line to edit), every key in the row above the input
  expect(d.keys).toEqual(['d', 'p', 'n', 'k', 'j', 'b'])
  expect(d.tree.find(n => n.type === 'Button' && n.props.hotkey === 'd').props.label).toBe('definition')
  await d.press('d')
  d = await drawn($)
  // the definition: each field in a row, its name in a gray column, the code whole
  expect(d.rows).toContain('kind     code')
  expect(d.tree.find(n => n.type === 'Code').props.source).toBe('def label(unit):\n    return len(unit["text"]) > 30')
  expect(d.rows).toContain('over     chat.jsonl')
  expect(d.rows.some(r => /^ {9}3 records/.test(r))).toBe(true)
  expect(d.keys).toEqual(['d', 'p', 'n', 'b'])
  expect(d.tree.find(n => n.type === 'Button' && n.props.hotkey === 'd').props.label).toBe('examples')
  // moving in the label keeps esc's way back to all the labels
  expect((await paneNow($))?.trail).toEqual([{ kind: 'labels', args: {}, title: 'Labels' }])
  await d.press('d')
  d = await drawn($)
  expect(d.rows.some(r => r.startsWith('examples · yes 2'))).toBe(true)
  await d.press('b')
  d = await drawn($)
  expect((await paneNow($))?.args).toEqual({})
  expect(d.keys).toEqual(['p', 'n', 'k', 'j'])
  // a press on a value opens it; on the open value again, all the labels
  const no = () => d.tree.find(n => n.type === 'Button' && String(n.props.key).endsWith(':v["sorry","no"]'))
  await no().props.onPress()
  expect((await paneNow($))?.args).toEqual({ label: 'sorry', value: 'no' })
  d = await drawn($)
  await d.press('b')
  // p from all the labels: the last value of the last label
  d = await drawn($)
  await d.press('p')
  expect((await paneNow($))?.args).toEqual({ label: 'long', value: 'no' })
})

test('the labels pane edits a field of the definition in its input bar: e the rule, ↵ applies the label again by the command Claude runs', async () => {
  const ran: string[][] = []
  const $ = paneEngine(ran)
  await $.state.set({ plugin: 'thimble', key: 'labelGen' }, 500)
  await openLabels($, { label: 'sorry', def: true })
  let d = await drawn($)
  expect(d.keys).toEqual(['e', 'd', 'p', 'n', 'b'])
  expect(d.tree.find(n => n.type === 'Button' && n.props.hotkey === 'e').props.label).toBe('edit rule')
  // the rule, the records it went over: a press each (a field's rows press it), no underline under the pointer
  const fields = d.tree.filter(n => n.type === 'Button' && /:f\[/.test(String(n.props.key)))
  expect(fields.map(n => String(n.props.key).replace(/^r\d+:/, ''))).toEqual(['f["rule"]', 'f["in"]'])
  expect(fields.every(n => n.props.hover?.underline === false)).toBe(true)
  await d.press('e')
  const args = (await paneNow($))?.args
  expect(args).toEqual({ label: 'sorry', value: 'yes', def: true, edit: 'rule' })
  d = await drawn($)
  // editing: the field marked, the keys ↵ and esc; the input bar holds the rule, named
  expect(d.rows).toContain('rule     (?i)sorry|apolog   ← editing')
  const said = (n: Any): string => (n == null ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(said).join('') : said(n.props?.children))
  expect(said(d.tree.find(n => n.props?.key === 'keys'))).toBe('↵ rerun over the same 3 records · esc cancel')
  const edit = await labelEdit($, args)
  expect([edit?.name, edit?.value]).toEqual(['rule', '(?i)sorry|apolog'])
  // ↵: back to the label, and the label applied again with the new rule, everything else as it was
  await edit!.submit('(?i)sorry')
  expect((await paneNow($))?.args).toEqual({ label: 'sorry', def: true })
  expect(ran.find(a => a.includes('--regex'))).toEqual(['label', 'sorry', '--in', 'chat.jsonl', '--regex', '(?i)sorry', '--values', 'yes,no', '--json'])
  // the same value again changes nothing
  ran.length = 0
  await $.state.set({ plugin: 'thimble', key: 'labelGen' }, 501)
  await openLabels($, { label: 'sorry', def: true, edit: 'in' })
  await (await labelEdit($, (await paneNow($))?.args))!.submit('chat.jsonl')
  expect(ran.some(a => a.includes('--regex'))).toBe(false)
})

test('the labels pane keeps its key row in its rows with a long list of examples, wrapped keys and all', async () => {
  const $ = paneEngine([], 60)
  // a new generation of the labels, so no read of an earlier test stands for this folder's
  await $.state.set({ plugin: 'thimble', key: 'labelGen' }, 1000)
  await openLabels($, { label: 'long' })
  for (const [W, H] of [[90, 40], [60, 24], [40, 26]]) {
    const d = await drawn($, W, H)
    // each child of the pane one row (the examples are cut to one row each), the keys' row wrapped at W, in the rows
    // the pane has over the side thread's input (threads/pane.tsx rowsUnder: 5 with no conversation)
    const kids = d.top.props.children as Any[]
    const keyRow = kids.at(-1)
    expect(keyRow.props.key).toBe('keys')
    const keyWidth = (keyRow.props.children as Any[]).reduce((s: number, n: Any) => s + (n.type === 'Button' ? 3 + n.props.label.length : String(n.props.children).length), 0)
    expect(kids.length - 1 + Math.ceil(keyWidth / W)).toBeLessThanOrEqual(Math.max(12, H - 5))
    expect(d.keys.slice(-2)).toEqual(['j', 'b'])
  }
})

test('the labels pane marks the words a code label matched, cut at words around them, and shows paths short', async () => {
  const ran: string[][] = []
  const $ = paneEngine(ran)
  const tmp = '/made-up/scratch/R2/tmp/thimble/prs.jsonl'
  const head = { ...HEAD, kind: 'code', rule: 'def label(u):\n    return "yes"', in: tmp }
  const hit = { before: `…${'early words '.repeat(20)}rebased onto main (whatsnew `, match: 'conflict', after: ` resolved). ${'later words '.repeat(20)}` }
  const recs = [
    { ref: `${tmp}#L5`, i: 0, value: 'yes', by: 'code', words: 'the record from its start', hit },
    { ref: 'runs/a/board.jsonl#L7', i: 1, value: 'yes', by: 'code', words: 'Nothing found here.', unmarked: 'the code matched “x” in text it changed; where is not known' },
  ]
  const run = $.process.run
  $.process.run = async (argv: string[]) => (argv.includes('--records')
    ? { exitCode: 0, stdout: JSON.stringify({ label: head, value: 'yes', at: 0, total: 2, records: recs }), stderr: '' }
    : argv.includes('--json') && argv.length <= 4 ? { exitCode: 0, stdout: JSON.stringify([head]), stderr: '' } : run(argv))
  await $.state.set({ plugin: 'thimble', key: 'labelGen' }, 98)
  await openLabels($, { label: 'sorry' })
  const W = 60
  let d = await drawn($, W)
  // the match, bold in the value's color, with whole words on each side and … only where cut, on one line
  const mark = d.tree.find(n => n.type === 'Text' && n.props.bold && words(n) === 'conflict')
  expect(mark.props.color).toBe('#5aa2e6')
  const said = d.rows.find(r => r.includes('conflict'))!
  expect(said).toMatch(/^ {2}line 5 {2}…[a-z]+ .*\(whatsnew conflict resolved\)\. later .*[a-z]…$/)
  expect(said).not.toMatch(/…(arly|rly|ly|y|ords) /)
  expect(said.length).toBeLessThanOrEqual(W)
  // picked: its place, a temp file with … in its middle; the next one says why no words are marked
  await d.press('j')
  d = await drawn($, W)
  expect(d.rows.some(r => /^ {10}\/made-up\/…\/thimble\/prs\.jsonl:5 +1: yes {2}2: no$/.test(r))).toBe(true)
  await d.press('j')
  d = await drawn($, W)
  expect(d.rows.some(r => r.trim().startsWith('the code matched “x” in text it changed; where is'))).toBe(true)
  // the definition: what the label went over, the temp file short
  await d.press('d')
  d = await drawn($, W)
  expect(d.rows).toContain('over     /made-up/…/thimble/prs.jsonl')
})
