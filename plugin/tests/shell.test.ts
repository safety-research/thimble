// The shell's hooks (shell/shell.tsx): an object Claude saves is placed under the turn's next words, a prompt asked
// while the detail view is open carries the object and its selected part, v's request to Claude reads as one line, and
// a resumed session draws its objects again. The message layer: each message's record on disk, its marks drawn inline,
// the bar under the prompt, the keys of an empty prompt, the tray and a question asked from it. `claude plugin test`.
// The Node children (the drawing, `thimble resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { plainWhy } from '../shell/shell'
import { press, promptStub } from './stubs'

const ROOT = '/data'
const FILE = `${ROOT}/thimble/objects/01-saves.json`
const OBJECT = {
  id: '01-saves', version: 1, title: 'Saves per day', question: 'When did the agents edit the wiki most?',
  program: 'return k.bars(...)', data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] },
  lineage: { cites: [] },
}
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' }, kid: { t: 'beside', kids: [{ t: 'text', runs: [{ s: 'Jun 18', tone: 'ink' }], wrap: false, w: 6 }, { t: 'bar', tone: 'accent', value: 6543, max: 6543 }, { t: 'text', runs: [{ s: '6,543', tone: 'ink' }], align: 'right', w: 5 }], gap: 1 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const RESOLVED = { ref: 'q1#day=2026-06-18@n', chain: [{ step: 'query', id: 'q1', about: 'saves per day' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'x' }], notes: [] }
// a quote's row, as `thimble resolve --json` gives its span: the rows around it, the quoted words placed in their field
const QUOTED = {
  ref: 'revisions.jsonl#L28', chain: [{ step: 'source', ref: 'revisions.jsonl#L28', kind: 'jsonl' }], rows: ['revisions.jsonl#L28'], count: 1, records: [], notes: [],
  span: { path: 'revisions.jsonl', file: '/data/revisions.jsonl', kind: 'jsonl', unit: 'line', cited: 1, raw: '{\n "label": "watcher",\n "change_summary": "the totals do not match"\n}',
    rows: [{ ref: 'revisions.jsonl#L27', n: 27, hot: false, text: 'an earlier save' }, { ref: 'revisions.jsonl#L28', n: 28, hot: true, text: 'the totals do not match', at: [4, 10], field: 'change_summary', meta: 'watcher' }] },
}
/** Tray cards drawn as one line of what each part shows (its head, or its rows with the cited one marked), where a
 *  test reads which part the tray shows: the test's sandbox runs no program from a string. */
let realCards = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const partWords = (d: any): string => String(d?.head ?? (Array.isArray(d?.rows) ? d.rows.map((r: { n: string; hot: boolean; text: string }) => `${r.n} ${r.hot ? '▌ ' : ''}${String(r.text).replace(/\{\w+:|\}|\*\*/g, '')}`).join(' / ') : ''))

const TRACE = { ...OBJECT, id: '02-trace', title: 'Trace · Jun 18' }
// what prep.mjs answers for a save's check (its interactions tried once): all ran, unless a test sets a failure
const ALL_RAN = { line: null, tried: 2, total: 2, failed: 0, cut: 0, ms: 3 }
let checked: unknown = ALL_RAN
const SHOWN = '/home/t/.thimble/lean/shown/s-1.json'

// the kernel's change feed: a save is a line there, which the shell reads after the Bash call (never its printed words)
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
/** A Bash call that saves `id` at version `v`: the kernel writes the save to the change feed, and prints that it saved. */
function saving(files: Record<string, string>, id = '01-saves', v = 1, root = ROOT) {
  return () => {
    files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root, object: id, version: v }) + '\n'
    return { result: `saved ${id} v${v}: thimble/objects/${id}.json\n` }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, drawing: unknown = DRAWING, env: Record<string, string> = {}, session = 's-1') {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', ...env })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: session }))
  const files: Record<string, string> = { [FILE]: JSON.stringify(OBJECT), [`${ROOT}/thimble/objects/02-trace.json`]: JSON.stringify(TRACE) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${ROOT}/thimble/objects` ? [{ name: '01-saves.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  const reads: string[] = []
  on('fs.read', (_$: unknown, e: { path: string }) => { reads.push(e.path); return { value: files[e.path] ?? promptStub(e.path) ?? '' } })
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  const stdins: string[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    stdins.push(String(e.init?.stdin ?? ''))
    // the feed's new bytes (`tail -c +N <file>`): the test's files are ASCII, so a byte is a character
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: (files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    let out: unknown = {}
    // a save the shell makes itself (a card from a fork): the kernel writes it to the change feed and says it saved
    if (e.argv[0]!.endsWith('/bin/thimble') && e.argv[1] === 'save') {
      const id = `03-${e.argv[2]}`
      files[`${ROOT}/thimble/objects/${id}.json`] = JSON.stringify({ ...OBJECT, id, ...JSON.parse(files[e.argv[4]!] || '{}') })
      files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: id, version: 1 }) + '\n'
      return { value: { exitCode: 0, stdout: `saved ${id} v1: thimble/objects/${id}.json`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const prep = e.argv.some(a => a.endsWith('prep.mjs')) ? JSON.parse(String(e.init?.stdin || '{}')) : null
    if (prep && realCards && prep.object?.version == null) out = { drawing: { ...DRAWING, w: prep.w, h: 1, root: { t: 'text', runs: [{ s: partWords(prep.object.data), tone: 'ink' }], wrap: false }, regions: [] } }
    else if (prep) out = { drawing, ...(prep.check ? { check: checked } : {}) }
    else if (e.argv.includes('resolve')) out = e.argv.includes('revisions.jsonl#L28') ? QUOTED : RESOLVED
    else if (e.argv.includes('coverage')) out = { files: [{ path: 'revisions.jsonl', rows: 300, lines: 300, status: 'seen', seen_lines: 102, computed: 0 }, { path: 'events.jsonl', rows: 300, lines: 300, status: 'named', computed: 0 }], total: { files: 2, rows: 600, seen_share: 102 / 600 } }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => {
    toasts.push(String(e.text ?? ''))
    return { value: undefined }
  })
  // the prompt box, as its editor applies an edit
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // Claude Code's hint line under the prompt, as a hook leaves it
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  return { runs, files, submitted, toasts, reads, stdins }
}

// every string a drawn tree holds, in order
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  // a Client's words are its props (a held pane, such as the squeeze chips: shell/keysclient.js draws its rows)
  if (n.type === 'Client') { const p = n.props?.props ?? {}; return (p.rows ?? []).map((r: { s: string }[]) => r.map(x => x.s).join('')).join('\n') + (p.hint ? `\n${p.hint}` : '') }
  return textOf(n.props?.children) + textOf(n.children)
}

const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const MOUNT = { plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any) => textOf(await $.ui.render(HINT))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
// every Button and every Markdown in a drawn tree
function walk(n: Node, f: (x: Node) => void): void {
  if (n == null || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return }
  f(n)
  walk(n.props?.children, f)
  walk(n.children, f)
}
const buttons = (t: Node) => { const out: Node[] = []; walk(t, x => { if (x.type === 'Button') out.push(x) }); return out }
/** The words a drawn tree shows dim, joined: the bar's keys that have nothing to act on. */
const dimText = (t: Node) => { const out: string[] = []; walk(t, x => { if (x.type === 'Text' && x.props?.dimColor) out.push(textOf(x)) }); return out.join('|') }
const markdowns = (t: Node) => { const out: string[] = []; walk(t, x => { if (x.type === 'Markdown') out.push(x.props.text) }); return out }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = ($: any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

test('an object Claude saves is drawn under the next words of the turn; its verbs are in the bar, and 1 opens its detail', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_$: unknown, e: { id: string }) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', saving(w.files))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: "thimble save saves <<'JSON'\n{}\nJSON" } as never)
  // Claude reads what the person sees of it, after the command's own output
  expect(String((saved as { context?: string[] }).context)).toContain('01-saves@1 is drawn for the analyst under your reply')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  const first = textOf(await reply($))
  expect(first).toContain('the reply')
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('the reply')
  expect(drawn).toContain('Jun 18')
  expect(drawn).toContain('6,543')
  // the message, then the object with nothing under it; the keys act on this answer, so the bar above the
  // prompt names its verbs (at rest the three alone), and 1 on an empty prompt opens the card's detail view
  expect(drawn).not.toContain('visualize')
  expect(drawn).not.toContain('1 open detail')
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze · c claims')
  expect(await hintOf($)).not.toContain('open detail')
  expect(drawn).not.toContain('x explore')
  expect(drawn).not.toContain('? all')
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  // the detail opens (and, once the key is gone from the prompt, opens again to take the keys)
  expect([...new Set(opened)]).toEqual(['object'])
})

test('a save is seen from the kernel\'s change feed, not from what the call printed: a pipe that cut "saved" still draws it', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  // `thimble save saves --from card.json | tail -1`: the line that says saved is gone, the feed has the save; then a
  // call that only prints the words
  let call = 0
  on('tool.call', () => (++call === 1 ? (saving(w.files)(), { result: '  this session has not read 3 of 4 source files\n' }) : { result: 'saved 09-other v1: thimble/objects/09-other.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'thimble save saves --from card.json | tail -1' } as never)
  expect(String((saved as { context?: string[] }).context)).toContain('01-saves@1 is drawn for the analyst under your reply')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  expect(textOf(await reply($))).toContain('6,543')
  // a call that saved nothing adds nothing, however its output reads
  const echo = await $.tool.call({ tool: 'Bash', command: 'echo "saved 09-other v1: thimble/objects/09-other.json"' } as never)
  expect((echo as { context?: string[] }).context ?? []).toEqual([])
})

test("a save tries the card's interactions once in the same child: a failure is one line for Claude, a pass adds nothing, and each check is in the events", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  let n = 0
  on('tool.call', () => saving(w.files, '01-saves', ++n)())
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const ok = String(((await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)) as { context?: string[] }).context)
  // the save's own drawing asked for the check, in the one child that drew it
  const preps = w.runs.map((r, i) => (r.some(a => a.endsWith('prep.mjs')) ? JSON.parse(w.stdins[i]!) : null)).filter(Boolean)
  expect(preps.length).toBe(1)
  expect(preps[0].check).toBe(true)
  expect(ok).toContain('01-saves@1 is drawn for the analyst under your reply')
  expect(ok).not.toContain('Tried as the analyst would')
  const line = 'Tried as the analyst would, turning zoom to orient fails: TypeError: data.steps.filter is not a function (line 22) (state {"zoom":"orient"}); 9 more fail the same way. Fix the program or the data it binds and save it again under the same name now, before the analyst tries it.'
  checked = { line, tried: 10, total: 10, failed: 10, cut: 0, ms: 21 }
  try {
    w.files[FILE] = JSON.stringify({ ...OBJECT, version: 2 })
    const bad = String(((await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)) as { context?: string[] }).context)
    expect(bad).toContain(line)
    await clock.advance(100)
    await clock.settle()
    const logged = w.stdins.filter(x => x.includes('"kind":"check"')).join('\n')
    expect(logged).toContain('"failed":10')
    expect(logged).toContain('"ms":21')
  } finally {
    checked = ALL_RAN
  }
})

test('the change feed is read from where the last read stopped: a call that saved nothing reads none of it, a later save only the new bytes', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  // the feed's size, as the file system says it
  on('fs.stat', (_$: unknown, e: { path: string }) => (e.path in w.files ? { value: { kind: 'file', size: w.files[e.path]!.length, mtimeMs: 0, isLink: false } } : { error: 'ENOENT' }) as never)
  let call = 0
  on('tool.call', () => (++call === 1 || call === 3 ? saving(w.files, call === 1 ? '01-saves' : '02-trace')() : { result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  // the first read since the module loaded: the whole feed, once
  const first = await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  expect(String((first as { context?: string[] }).context)).toContain('01-saves@1 is drawn')
  expect(w.reads.filter(p => p === EVENTS).length).toBe(1)
  // a call that saved nothing: the feed's size is the same, so nothing of it is read
  const quiet = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((quiet as { context?: string[] }).context ?? []).toEqual([])
  expect(w.reads.filter(p => p === EVENTS).length).toBe(1)
  expect(w.runs.filter(r => r[0] === 'tail').length).toBe(0)
  // a later save: only the bytes after the last read, through tail
  const later = await $.tool.call({ tool: 'Bash', command: 'thimble save trace' } as never)
  expect(String((later as { context?: string[] }).context)).toContain('02-trace@1 is drawn')
  expect(String((later as { context?: string[] }).context)).not.toContain('01-saves@1')
  expect(w.reads.filter(p => p === EVENTS).length).toBe(1)
  const tail = w.runs.find(r => r[0] === 'tail')!
  expect(Number(tail[2]!.slice(1)) - 1).toBe(w.files[EVENTS]!.split('\n')[0]!.length + 1)
})

test('a reply after no save draws as Claude Code draws it', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  expect(textOf(await reply($))).toBe('the reply')
})

test('while the detail view is open, a prompt carries the object and its selected part', async ($, on) => {
  const w = world(on)
  const { runs } = w
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: false, isPlaced: true, plugin: 'thimble' }] }))
  await $.command.run({ command: 'card', args: 'saves day-2026-06-18' } as never)
  // the region's rows were resolved for the view, as the person's, not as what Claude read
  const resolve = runs.find(a => a.includes('resolve'))
  expect(resolve).toBeDefined()
  expect(resolve!.includes('q1#day=2026-06-18@n')).toBe(true)
  await $.prompt.submit({ text: 'why is this day so high?' } as never)
  const carried = w.submitted.at(-1)!.context
  expect(carried.length).toBe(1)
  expect(carried[0]).toContain('01-saves@1')
  expect(carried[0]).toContain('day-2026-06-18')
  expect(carried[0]).toContain('q1#day=2026-06-18@n')
})

test('a reply draws its citations inline, each underlined and a press that opens its source card in the tray', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const text = 'June 18 had [6,543 saves](q1#day=2026-06-18@n); [4,219](q9#kind=SEC via proxy@n) went through a proxy, as [this one](revisions.jsonl#L28) and [a page](https://example.org/x).\n\nA plain closing line.'
  const ui = await $.ui.mount({ ...(MOUNT as object), props: { text, isFirstOfReply: true } } as never)
  const tree = await ui.drawn()
  const shown = textOf(tree)
  // the citations read as their words, in place; the plain paragraph is Claude Code's own Markdown
  expect(shown).toContain('June 18 had 6,543 saves; 4,219 went through a proxy, as this one and a page')
  expect(shown).not.toContain('q1#day')
  const cite = buttons(tree).find(b => b.props.label === 'cite 6,543 saves')!
  expect(cite).toBeDefined()
  expect(JSON.stringify(cite)).toContain('"underline":true')
  expect(buttons(tree).map(b => b.props.label)).toEqual(['cite 6,543 saves', 'cite 4,219', 'cite this one'])
  expect(markdowns(tree)).toEqual(['A plain closing line.'])
  // a press opens the tray on it: its source card, read through the kernel
  await ui.press({ key: cite.props.key })
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  await clock.settle()
  const card = textOf(await $.ui.render(BAND))
  expect(card).toContain('Jun 18')
  // the tray's keys are in the bar under it, not on its frame
  expect(card.split('╯')[0]).not.toContain('a ask')
  // with the keys of the card's sections: the rows behind the value, and its code
  expect(await hintOf($)).toContain('thimble  ↵ open · r rows · c code · 0 close · ] next')
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q1#day=2026-06-18@n'))).toBe(true)
  await ui.unmount()
})

test('a quote opens its span under its file\'s place, never an address; c shows the record as the file holds it in the same panel, and a letter typed straight after c is a word', async ($, on) => {
  const w = world(on)
  w.files[`${ROOT}/revisions.jsonl`] = '{}\n'
  const clock = mock.clock(on)
  realCards = true
  try {
    await markedTurn($, on, clock)
    await press($, clock, edit(']'))
    await press($, clock, edit(']'))
    // the card is read through the kernel once the tray asks for it
    await $.ui.render(BAND)
    await clock.settle()
    const band = await $.ui.render(BAND)
    // the cited row in full, the quoted words in their field, the row before it stepped back
    expect(textOf(band)).toContain('27 an earlier save / 28 ▌ change_summary: the totals do not match')
    // the file's place in its own words, a press: this terminal names no hyperlinks, so no address shows beside it
    expect(buttons(band).map(b => b.props.label)).toContain('open revisions.jsonl:28')
    expect(textOf(band)).toContain('revisions.jsonl:28')
    expect(JSON.stringify(band)).not.toContain('file://')
    expect(await hintOf($)).toContain('thimble  ↵ open · c raw · 0 close · ] next')
    // c: the record as the file holds it, in place of the span, in the same panel
    expect(await press($, clock, edit('c'))).toEqual({ text: '', cursor: 0 })
    let now = textOf(await $.ui.render(BAND))
    expect(now).toContain('revisions.jsonl:28, as the file holds it')
    expect(now).not.toContain('27 an earlier save')
    expect(now).toContain('cite · revisions.jsonl · raw')
    expect(await hintOf($)).toContain('thimble  ↵ open · c raw · 0 back · ] next')
    // 0 brings the span back; the tray stays open
    expect(await press($, clock, edit('0'))).toEqual({ text: '', cursor: 0 })
    now = textOf(await $.ui.render(BAND))
    expect(now).toContain('28 ▌ change_summary')
    expect(now).not.toContain('as the file holds it')
    // a number has no file of its own: no link under it
    await press($, clock, edit('['))
    await $.ui.render(BAND)
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
    expect(markdowns(await $.ui.render(BAND)).some(m => m.startsWith('↗'))).toBe(false)
    await press($, clock, edit(']'))
    // c, then a letter at once: the person began a word (a question for the mark's thread), so c is given back
    await press($, clock, edit('c'))
    expect(await press($, clock, edit('a'))).toEqual({ text: 'ca', cursor: 2 })
    expect(textOf(await $.ui.render(BAND))).not.toContain('as the file holds it')
  } finally {
    realCards = false
  }
})

test('in tmux 3.4 the file\'s place is an OSC 8 link to the file; a click on it opens the cited lines in the side panel, and the tray gives way', async ($, on) => {
  const w = world(on, DRAWING, { TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.4' })
  w.files[`${ROOT}/revisions.jsonl`] = '{}\n'
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Cite', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('ui.focus', () => ({}))
  const clock = mock.clock(on)
  realCards = true
  try {
    await markedTurn($, on, clock)
    await press($, clock, edit(']'))
    await press($, clock, edit(']'))
    await $.ui.render(BAND)
    await clock.settle()
    const href = 'file:///data/revisions.jsonl#L28'
    expect(markdowns(await $.ui.render(BAND))).toContain(`[revisions.jsonl:28](${href})`)
    // a plain click on it is thimble's: the cited lines in the side panel, as the mark's thread
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'tray-file', link: { href } })
    await clock.settle()
    expect(opened.some(x => x.id === 'object' && /Cite · this one/.test(String(x.title)))).toBe(true)
    expect(textOf(await $.ui.render(BAND))).not.toContain('╭─ this one')
    await ui.unmount()
  } finally {
    realCards = false
  }
})

// ------------------------------------------------------------------------------------------------ keys, pressed


/** A turn that saves 01-saves and ends with words: the object is drawn under them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function savedTurn($: any, on: any, clock: { settle: () => Promise<void> }, files: Record<string, string>) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', saving(files))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test("v asks Claude for a card of the message: the row reads as the person's pick, the request beside it for Claude alone", async ($, on) => {
  const ask = 'The analyst pressed v (visualize) on your answer that begins "June 18 had the most saves.". They want another view of it'
  const w = world(on)
  const session = mock.session(on)
  const clock = mock.clock(on)
  await savedTurn($, on, clock, w.files)
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  // v on an empty prompt, as the bar names it
  await press($, clock, edit('v'))
  // with no view proposed v opens no line: it asks once a letter could no longer make it the start of a word
  expect(textOf(await ui.drawn())).not.toContain('another view of this answer')
  await clock.advance(700)
  await clock.settle()
  // the row reads as the press; Claude reads the request in a row before it that the person does not see
  expect(w.submitted.map(x => x.text)).toEqual(['visualize another view of this answer'])
  const rows = session.appended() as unknown as { door: string; message: { type: string; content: { text?: string }[] } }[]
  const hidden = rows.filter(r => r.door === 'note' && r.message.type === 'user' && r.message.content.some(b => String(b.text).includes(ask)))
  expect(hidden.length).toBe(1)
  // the card guide is named by its file in this plugin, for Claude to read first
  expect(String(hidden[0]!.message.content[0]!.text)).toMatch(/Read the card guide first, unless you have it from earlier in this session: \S+\/skills\/thimble\/cards\.md\./)
  await ui.unmount()
})

test('a view that fails to draw: no prompt and no row; Claude reads why, at once after its save', async ($, on) => {
  const failed = { ...DRAWING, error: { name: 'TypeError', message: 'data.days is undefined', line: 3 } }
  const w = world(on, failed)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', saving(w.files))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  expect(String((saved as { context?: string[] }).context)).toContain('Fix the program and save it again under the same name now')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never)
  await clock.settle()
  expect(w.submitted.length).toBe(0)
})

test('an object whose file cannot be read is not drawn in silence: Claude reads why with the save', async ($, on) => {
  const w = world(on)
  w.files[FILE] = '{"id": "01-saves", "data": ' // a read that does not give the whole file, as one over 4 MiB
  mock.clock(on)
  on('tool.call', saving(w.files))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  expect(String((saved as { context?: string[] }).context)).toContain('The analyst cannot see the card 01-saves')
  expect(String((saved as { context?: string[] }).context)).toContain('could not be read')
})

test('a resumed session draws its objects under the same replies again', async ($, on) => {
  const w = world(on)
  w.files[SHOWN] = JSON.stringify({ under: { [AT]: [{ id: '01-saves', v: 1, root: ROOT }] } })
  const clock = mock.clock(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  textOf(await reply($))
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('Jun 18')
  expect(drawn).not.toContain('open ›')
})

// ------------------------------------------------------------------------------------------------ the message layer

const MARKED = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18, from [this one](revisions.jsonl#L28) on. The `fixture scope` mattered.'
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

/** A turn that answers with marked words and ends: its record is written and its verb row drawn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markedTurn($: any, on: any, clock: { settle: () => Promise<void> }, text = MARKED) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000000', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'when?' }] } } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test("each row is written to the messages folder: an index line per row, and a record of Claude's message with its marks", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  const dir = `${ROOT}/thimble/messages/s-1`
  const index = w.files[`${dir}/index.jsonl`]!.trim().split('\n').map(l => JSON.parse(l))
  expect(index.map((x: { kind: string }) => x.kind)).toEqual(['user', 'assistant'])
  expect(index[0].text).toBe('when?')
  expect(index[1].row).toBe(AT)
  const rec = JSON.parse(w.files[`${dir}/${AT}.json`]!)
  expect(rec.v).toBe(1)
  expect(rec.session).toBe('s-1')
  expect(rec.text).toBe(MARKED)
  expect(rec.shown).toBe(null)
  expect(rec.final).toBe(true)
  expect(rec.marks.map((m: { kind: string; label?: string }) => `${m.kind} ${m.label}`)).toEqual(['cite 6,543 saves', 'cite this one'])
  expect(MARKED.slice(rec.marks[0].start, rec.marks[0].end)).toBe('[6,543 saves](q1#day=2026-06-18@n)')
})

test('keys of an empty prompt: ] opens the tray on the next mark and 0 goes back; a letter typed straight after v gives v back to the prompt', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  // the hint line names the key that opens the answer's marks; the verb row does not
  expect(textOf(await $.ui.render({ ...(MOUNT as object), props: { text: MARKED, isFirstOfReply: true } } as never))).not.toContain('marks')
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze · c claims')
  expect(await hintOf($)).not.toContain('cite & explain')
  // the bar above the prompt says how much of the data the session read
  expect(textOf(await $.ui.render(BAND))).toContain('seen 17%')
  expect(textOf(await $.ui.render(BAND))).not.toContain('6,543 saves')
  // ] : the first mark of the latest message, in the tray; the key never reaches the prompt
  expect(await press($, clock, edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  expect(await hintOf($)).toContain('thimble  ↵ open · 0 close · ] next')
  await press($, clock, edit(']'))
  expect(textOf(await $.ui.render(BAND))).toContain('this one')
  await press($, clock, edit('['))
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  // with the tray open the prompt is main's: letters are typed
  expect(await press($, clock, edit('w'))).toEqual({ text: 'w', cursor: 1 })
  // 0 on an empty prompt closes the tray
  expect(await press($, clock, edit('0'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(BAND))).toContain('v visualize')
  expect(textOf(await $.ui.render(BAND))).not.toContain('6,543 saves')
  // v waits a moment before it asks; i typed straight after was the start of a word, so v comes back and asks nothing
  const asked = w.submitted.length
  expect(await press($, clock, edit('v'))).toEqual({ text: '', cursor: 0 })
  expect(await press($, clock, edit('i'))).toEqual({ text: 'vi', cursor: 2 })
  await clock.advance(700)
  await clock.settle()
  expect(w.submitted.length).toBe(asked)
  // a key in a prompt with words in it is typed
  expect(await press($, clock, edit('s', 'so'))).toEqual({ text: 'sos', cursor: 3 })
})

// Claude Code gives a prompt.edit hook 50 ms of its own time: a `$` call in flight is free, but a wait for anything else
// counts (the hooks worker busy drawing, the work of the key before). Past it the hook's .catch answers, and past the
// .catch's grace (a second) the key types. A key's work runs after its answer, so it never counts against that time.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** The shell's next write of its state takes `ms` when asked, as slow work does (a key's work writes, its answer
 *  never does). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slowWrites(on: any) {
  let ms = 0
  on('state.set', async (_$: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => {
    const wait = ms
    ms = 0
    if (wait) await sleep(wait)
    return next(e)
  })
  return { next: (n: number) => { ms = n } }
}
// the squeeze chips under the answer: the line a key opens in these tests
const lineOpen = async ($: Any) => textOf(await $.ui.render(MOUNT)).includes('Length ○○●○○ as written')

test('a key is answered before its work runs; a key pressed while that work runs waits for it, past the hook\'s 50 ms, and is still taken: the .catch gives what the hook decided', async ($, on) => {
  const w = world(on)
  const writes = slowWrites(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  writes.next(300)
  // s answers at once, while its work (the chips it opens) still runs
  expect(await Promise.race([($ as Any).prompt.edit(edit('s')), sleep(150).then(() => 'no answer yet')])).toEqual({ text: '', cursor: 0 })
  // 1 straight after: decided once s's work is done, so it picks a chip; it never lands in the prompt
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  expect(w.submitted.length).toBe(0)
  expect(await lineOpen($)).toBe(true)
})

test('a key whose answer misses even the .catch\'s grace types, and its work never runs: a key is taken or typed, never both', async ($, on) => {
  const w = world(on)
  const writes = slowWrites(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  writes.next(1400)
  expect(await Promise.race([($ as Any).prompt.edit(edit('s')), sleep(150).then(() => 'no answer yet')])).toEqual({ text: '', cursor: 0 })
  // 1 waits for s's work longer than the hook's budget and the .catch's grace together: Claude Code types it
  expect(await ($ as Any).prompt.edit(edit('1'))).toEqual({ text: '1', cursor: 1 })
  // s's work ends; the 1 that typed picks nothing, and the chips stay open
  await sleep(500)
  await clock.settle()
  expect(w.submitted.length).toBe(0)
  expect(await lineOpen($)).toBe(true)
})

// A key typed before the answer to the key before it came is raised on the box as the person saw it (v, then i: an
// edit of "v" to "vi"), while the editor has taken the v out since and shows "i". The answer is laid over that box as a
// change from the edit's own "vi": what the editor shows then is the answer with the taken v out of it too.
const shows = (answer: { text: string; cursor: number }, taken: string) => answer.text.slice(taken.length)

test('a letter typed before s\'s answer came, on the box with the s still in it, is the start of a word: the s comes back and its line closes', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  expect(await ($ as Any).prompt.edit(edit('s'))).toEqual({ text: '', cursor: 0 })
  // o, typed while the editor still showed the s: answered at once, so the editor shows "so"
  const o = await ($ as Any).prompt.edit(edit('o', 's'))
  expect(shows(o, 's')).toBe('so')
  await clock.settle()
  expect(await lineOpen($)).toBe(false)
  // a key so typed that the chips take is decided on the empty box, once they are open: 1 picks a chip, no letter lands
  expect(await ($ as Any).prompt.edit(edit('s'))).toEqual({ text: '', cursor: 0 })
  expect(shows(await press($, clock, edit('1', 's')), 's')).toBe('')
  expect(await lineOpen($)).toBe(true)
})

test('a letter typed straight after s is a word however long s\'s work takes: the time counts from when each key came', async ($, on) => {
  world(on)
  const writes = slowWrites(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  writes.next(300)
  expect(await ($ as Any).prompt.edit(edit('s'))).toEqual({ text: '', cursor: 0 })
  // o comes at once, and waits for s's work, which takes longer than the gap a word allows
  const o = ($ as Any).prompt.edit(edit('o'))
  await sleep(20)
  await clock.advance(1000)
  expect(await o).toEqual({ text: 'so', cursor: 2 })
  await clock.settle()
  expect(await lineOpen($)).toBe(false)
})

test('with the tray open, 1 opens the citation in the side panel as its thread, its input bar holding the keys; a prompt typed in the prompt is main\'s, with the citation as context', async ($, on) => {
  const w = world(on)
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Cite', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('ui.focus', () => ({}))
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  await press($, clock, edit(']'))
  // a prompt typed with the tray open goes to main, carrying the citation (main's prompt is main's)
  const before = w.submitted.length
  const r = await $.prompt.submit({ text: 'why so high?', origin: { kind: 'composer' } } as never)
  expect((r as Any).drop).toBeUndefined()
  expect(w.submitted.length).toBe(before + 1)
  expect(String(w.submitted.at(-1)!.context)).toContain('a citation of your reply open in the tray: 6,543 saves (q1#day=2026-06-18@n)')
  // 1: the side panel on the citation's card, as its thread; the tray gives way to it
  await press($, clock, edit(']'))
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  expect(opened.some(x => x.id === 'object' && /Cite · 6,543 saves/.test(String(x.title)))).toBe(true)
  expect(textOf(await $.ui.render(BAND))).not.toContain('╭─ 6,543 saves')
  // the bar names the thread and what esc does there, and no key of the panel's
  const bar = await hintOf($)
  expect(bar).toContain('thimble:main/6,543 saves')
  expect(bar).toContain('esc close')
})

test("a resumed session finds its messages on disk: their marks open from the keys, and the keys act on its latest answer", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const dir = `${ROOT}/thimble/messages/s-1`
  const rec = { v: 1, row: AT, session: 's-1', text: MARKED, shown: null, marks: [{ kind: 'cite', start: 7, end: 42, ref: 'q1#day=2026-06-18@n', label: '6,543 saves' }], glosses: {}, verbs: { s: { lit: true, note: '24 lines' } }, objects: [], final: true }
  w.files[`${dir}/index.jsonl`] = `${JSON.stringify({ row: 'pppppppp-0000-0000-0000-', kind: 'user', text: 'when?' })}\n${JSON.stringify({ row: AT, kind: 'assistant' })}\n`
  w.files[`${dir}/${AT}.json`] = JSON.stringify(rec)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const RESUMED = { ...(MOUNT as object), props: { text: MARKED, isFirstOfReply: true } } as never
  // (an older record's lit s says a count of lines: the bar says no line counts)
  expect(textOf(await $.ui.render(HINT))).toContain('v visualize · s squeeze')
  expect(textOf(await $.ui.render(HINT))).not.toContain('lines')
  await press($, clock, edit(']'))
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  await press($, clock, edit('0'))
  await press($, clock, edit('s'))
  // s opens the squeeze chips under it, in place of its verb row
  expect(textOf(await $.ui.render(RESUMED))).toContain('Interpretation')
})

test('a record an earlier version kept with an explain after its text: the explain stands inside the citation, and a press on it opens it', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const dir = `${ROOT}/thimble/messages/s-1`
  const TEXT = 'Most requests carry only an action, such as [browse-bare](events.jsonl#L1). The other [30](q1#day=2026-06-18@n) keep more.'
  const at = (s: string) => ({ start: TEXT.indexOf(s), end: TEXT.indexOf(s) + s.length })
  const cite1 = { kind: 'cite', ...at('[browse-bare](events.jsonl#L1)'), ref: 'events.jsonl#L1', label: 'browse-bare' }
  const cite2 = { kind: 'cite', ...at('[30](q1#day=2026-06-18@n)'), ref: 'q1#day=2026-06-18@n', label: '30' }
  const rec = { v: 1, row: AT, session: 's-1', text: TEXT, shown: null, marks: [cite1, cite2, { kind: 'gloss', start: TEXT.length, end: TEXT.length, gloss: 'g1', loose: true, inLink: true }], glosses: { g1: { term: 'browse-bare', title: 'browse-bare', body: 'A request that only reads a page.' } }, verbs: {}, objects: [], final: true }
  w.files[`${dir}/index.jsonl`] = `${JSON.stringify({ row: 'pppppppp-0000-0000-0000-', kind: 'user', text: 'requests?' })}\n${JSON.stringify({ row: AT, kind: 'assistant' })}\n`
  w.files[`${dir}/${AT}.json`] = JSON.stringify(rec)
  const ui = await $.ui.mount({ ...(MOUNT as object), props: { text: TEXT, isFirstOfReply: true } } as never)
  await clock.settle()
  const tree = await ui.drawn()
  expect(textOf(tree)).not.toContain('explain:')
  const g = buttons(tree).find(b => b.props.label === 'explain browse-bare')!
  expect(g).toBeDefined()
  await ui.press({ key: g.props.key })
  await clock.settle()
  // the tray opens on the explainer pressed, not on the citation after it
  const band = textOf(await $.ui.render(BAND))
  expect(band).toContain('╭─ browse-bare ─')
  expect(band).toContain(' explain ─')
  expect(band).not.toContain('╭─ 30 ')
  await ui.unmount()
})

test('a failure reads as plain words, never JSON; a refusal that needs nothing from the person says nothing', () => {
  // the engine refuses a scroll that a key asked for, or one to a mark not drawn now: the tray shows the mark anyway
  expect(plainWhy({ deny: 'not person-initiated' })).toBeNull()
  expect(plainWhy('scroll: {"deny":"no element of its own is drawn under that key"}')).toBeNull()
  expect(plainWhy(new Error('thimble: $.ui.scroll: not person-initiated'))).toBeNull()
  // a real failure keeps its own words
  expect(plainWhy(new Error('thimble: $.model.complete: the model is busy'))).toBe('the model is busy')
  expect(plainWhy('{"error":"q9 has no column n"}')).toBe('q9 has no column n')
  expect(plainWhy('Traceback (most recent call last):\n  File "x"')).toBe('Traceback (most recent call last):')
})

test('the bar is one row above the prompt: the verbs in words at its left, a lit one with its note; at its right the threads and coverage (the share read), when not zero; a changed count bright for a moment; a blank row above it; its label plain', async ($, on) => {
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  const bar = textOf(await $.ui.render(HINT))
  expect(bar).toContain('thimble  v visualize · s squeeze · c claims')
  // 102 of 600 rows read, as the kernel counts them (events.jsonl was only named): 17%; no zero count shows
  expect(bar).toContain('seen 17%')
  expect(bar).not.toContain('cites')
  expect(bar).not.toContain('card')
  expect(bar).not.toContain('thread')
  expect(bar).not.toMatch(/\d claims?\b/)
  // the counts that just changed are bright, then dim
  const lit = (t: Any) => { let on = false; walk(t, x => { if (x.type === 'Text' && x.props?.bold && textOf(x).trim() === 'seen 17%') on = true }); return on }
  expect(lit(await $.ui.render(HINT))).toBe(true)
  for (let i = 0; i < 40; i++) await clock.advance(50)
  expect(lit(await $.ui.render(HINT))).toBe(false)
  // a blank row stands between the bar and what is above it (Claude Code's spinner or its last status row), at rest as
  // while Claude works
  const rest = await $.ui.render(BAND) as Any
  expect(textOf(rest).startsWith(' thimble')).toBe(true)
  const working = await $.ui.render({ ...(BAND as object), props: { ...(BAND as Any).props, isWorking: true } } as never) as Any
  expect(textOf(working).startsWith(' thimble')).toBe(true)
  // the label is no link and no press: it wears no underline, the citations' look
  let underlined = false
  walk(rest, x => { if (x.type === 'Text' && x.props?.underline && textOf(x) === 'thimble') underlined = true })
  expect(underlined).toBe(false)
  // inside a thread (the side panel on a citation) the bar's label names it, and its left side says what esc does
  // there and nothing more: the panel names no keys
  await press($, clock, edit(']'))
  await press($, clock, edit('1'))
  const inThread = textOf(await $.ui.render(HINT))
  expect(inThread).toContain('thimble:main/6,543 saves')
  expect(inThread).toContain('esc close')
  expect(inThread).not.toContain('type to ask')
})

/** One more answer of Claude's: a turn (the person's prompt or not) whose last words are `text`, ended as `reason`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function answerTurn($: any, clock: { settle: () => Promise<void> }, o: { turn: string; uuid: string; text: string; prompt?: string; reason?: string }) {
  await $.turn.start({ turnId: o.turn, text: o.prompt ?? '' } as never)
  if (o.prompt) await $.session.append({ door: 'prompt', uuid: `${o.turn.padEnd(8, 'p')}-0000-0000-0000-000000000000`, origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: o.prompt }] } } as never)
  await $.session.append({ door: 'response', uuid: o.uuid, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: o.text }] } } as never)
  await $.turn.complete({ turnId: o.turn, answer: o.text, durationMs: 5, reason: o.reason ?? 'answer', isAborted: false } as never)
  await clock.settle()
}

test('the keys act on the newest answer, never on an error; { and } pick another answer, which the bar names and the reply marks', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const LONG = 'bbbbbbbb-0000-0000-0000-000000000001'
  const SHORT = 'cccccccc-0000-0000-0000-000000000002'
  const ERR = 'dddddddd-0000-0000-0000-000000000003'
  // the person's question, its long answer, then a subagent's short follow-up, then a turn that ended in an error
  await answerTurn($, clock, { turn: 't1', uuid: LONG, text: MARKED, prompt: 'when?' })
  await answerTurn($, clock, { turn: 't2', uuid: SHORT, text: 'The second reader is done too.' })
  await answerTurn($, clock, { turn: 't3', uuid: ERR, text: 'API Error: 401 Authentication failed', reason: 'error' })
  // the keys act on the short follow-up (the error answered nothing); at rest the bar names nothing more (two replies
  // since the prompt: s catches up)
  let bar = await hintOf($)
  expect(bar).toContain('v visualize · s catch up · c claims')
  expect(bar).not.toContain('{ }')
  // { picks the long answer: its marks are the keys' now, the bar names which reply, and its first row shows ▸ in place
  // of its bullet
  expect(await press($, clock, edit('{'))).toEqual({ text: '', cursor: 0 })
  bar = await hintOf($)
  expect(bar).toContain('{ } reply 1 of 2')
  const long = textOf(await $.ui.render({ ...(MOUNT as object), requestId: LONG, props: { text: MARKED, isFirstOfReply: true } } as never))
  expect(long.startsWith('▸')).toBe(true)
  // } gives the keys back to the newest answer; no key of the bar reads as an arrow key
  await press($, clock, edit('}'))
  expect(await hintOf($)).not.toContain('{ }')
  expect(await hintOf($)).not.toMatch(/[<>←→]/)
})

test('a conversation continued in a new session (moved to the background, --fork-session) finds its records: the cards under its replies and its answers', async ($, on) => {
  const w = world(on, undefined, {}, 's-2')
  const clock = mock.clock(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  // Claude Code keeps the conversation's first launch in every continuation, and the new session carries its transcript
  on('session.usage', () => ({ value: { startedAt: 1700000000000, context: {}, rateLimits: [] } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'when?', toolUses: [] }, { role: 'assistant', text: 'June 18 had the most saves.', toolUses: [] }] }))
  const CONV = '/home/t/.thimble/lean/conversations/1700000000000.json'
  // what the first session (s-1) kept: its conversation, the card under its answer, the answer's record
  w.files[CONV] = JSON.stringify({ key: 's-1', sessions: ['s-1'] })
  w.files[SHOWN] = JSON.stringify({ under: { [AT]: [{ id: '01-saves', v: 1, root: ROOT }] } })
  const dir = `${ROOT}/thimble/messages/s-1`
  w.files[`${dir}/index.jsonl`] = `${JSON.stringify({ row: 'pppppppp-0000-0000-0000-', kind: 'user', text: 'when?' })}\n${JSON.stringify({ row: AT, kind: 'assistant' })}\n`
  w.files[`${dir}/${AT}.json`] = JSON.stringify({ v: 1, row: AT, session: 's-1', text: 'June 18 had the most saves.', shown: null, marks: [], glosses: {}, verbs: {}, objects: ['01-saves'], final: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  // the card is drawn under the same reply (once its drawing is ready), and the keys act on its answer
  await reply($)
  await clock.settle()
  expect(textOf(await reply($))).toContain('6,543')
  const bar = await hintOf($)
  expect(bar).toContain('v visualize')
  // the new session joined the conversation, and its commands file their records under its key
  expect(JSON.parse(w.files[CONV]!).sessions).toEqual(['s-1', 's-2'])
})

test('a session of the background service starts no Node child until the person\'s first prompt', async ($, on) => {
  const w = world(on, undefined, { CLAUDE_CODE_SESSION_KIND: 'bg' })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  const children = () => w.runs.filter(r => r.includes('coverage')).length
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  expect(children()).toBe(0)
  await $.prompt.submit({ text: 'when?', origin: { kind: 'composer' } } as never)
  await clock.settle()
  expect(children()).toBe(1)
})

test('a -p run starts no Node child for the line nobody reads', async ($, on) => {
  const w = world(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
  await $.prompt.submit({ text: 'when?', origin: { kind: 'sdk' } } as never)
  await clock.settle()
  expect(w.runs.filter(r => r.includes('coverage')).length).toBe(0)
})
