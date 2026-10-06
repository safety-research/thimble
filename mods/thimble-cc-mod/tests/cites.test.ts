// Citations and fix rounds: `claude plugin test mods/thimble-cc-mod`. The hooks registered here stand for the engine: a
// filesystem in memory, the resolver and subagents.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { SPIN, answerFile, applyCorrections, blockLayout, capLine, chipLook, chipSegs, chipState, citedAs, citedPlace, claimsIn, correctText, emptyMarks, fixItems, fixPrompt, marksJson, paraLayout, parseFix, parseMarks, passageAt, placeIn, quoteSpan, quotedWords, scriptAim, sentenceAt, sentenceIn, setMark, settleFix, showsValue, streamLink, streamStep, streaming, verifyMatches, wrapAround } from '../hooks/cite'
import type { ChipView } from '../hooks/cite'
import { lineWidth } from '../hooks/draw'
import { MOD_AGENT, fallbackName, fixName, forkPrompt, parseThread, pinCalls, threadJson, threadName, threadNote, verifyName, withNotes, withoutTaskLine } from '../hooks/threads'
import { citations, inlineRuns, parseReply, tableCells } from '../hooks/lib'
import { verifyPrompt as reportVerifyPrompt } from '../hooks/report'
import { COLORS } from '../hooks/paint'

const CWD = '/corpus/wiki'
const CARD = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
}
const BAD = 'probier has [[1014|card:abc123#revisions/probier]], see [[pages.jsonl#L3]].'
const REPLY = ['[[card:abc123]]', '', 'dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.', '', BAD].join('\n')
const FIXED = 'probier has [[1013|card:abc123#revisions/probier]], see [[pages.jsonl#L3]].'
/** A table card longer than the rows a card draws (15). */
const TABLE = {
  id: 't4b1e0',
  kind: 'table',
  question: 'How many revisions does each wiki have?',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/table.py', index: 0 },
  columns: ['wiki', 'revisions'],
  rows: Array.from({ length: 20 }, (_, i) => [`w${i + 1}`, (i + 1) * 111]),
}

type World = { opened: { id: string; focus?: boolean }[]; files: Map<string, string>; spawned: { prompt: string; subagentType?: string; description?: string }[]; submitted: string[]; contexts: (readonly string[])[]; appended: { type: string; text: string }[]; session: string; messages: { role: string; text: string }[]; verifyOut: string; lines?: { n: number; text: string; hit: boolean }[]; clock?: { advance: (ms: number) => Promise<void> } }

function resolveOne(ref: string, display: string | null) {
  const values: Record<string, string> = { 'card:abc123#revisions/dse': '13403', 'card:abc123#revisions/probier': '1013', 'card:abc123#revisions/all': '14416' }
  if (ref in values) {
    const v = values[ref]!
    const ok = display === null || display === v
    return { ref, kind: 'value', card: 'abc123', column: 'revisions', row: ref.split('/').at(-1), value: v, status: ok ? 'ok' : 'differs', why: ok ? `the card shows ${v}` : `the card shows ${v}, not ${display}`, window: [] }
  }
  const t = /^card:t4b1e0#revisions\/(w\d+)$/.exec(ref)
  if (t) {
    const v = String(Number(t[1]!.slice(1)) * 111)
    return { ref, kind: 'value', card: 't4b1e0', column: 'revisions', row: t[1], value: v, status: display === null || display === v ? 'ok' : 'differs', why: `the card shows ${v}`, window: [] }
  }
  if (ref === 'card:abc123') return { ref, kind: 'card', card: 'abc123', status: 'ok', why: 'the card exists', window: [] }
  if (ref === 'pages.jsonl#L3') return { ref, kind: 'lines', file: 'pages.jsonl', start: 3, end: 3, status: 'ok', why: 'resolves', window: [{ n: 3, text: '{"name": "Main"}', hit: true }] }
  // link words that show no value: the resolver finds the place and checks nothing
  if (ref === 'revisions.jsonl#L5603-L5625') return { ref, kind: 'lines', file: 'revisions.jsonl', start: 5603, end: 5625, status: 'unchecked', why: "resolves; the link's words are not a number or a quote, so not checked", window: [{ n: 5603, text: '{"page": "Main", "label": "a"}', hit: true }] }
  return { ref, kind: 'file', status: 'missing', why: `no file ${ref}`, window: [] }
}

function world(on: On): World {
  const w: World = { opened: [], files: new Map([[`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)]]), spawned: [], submitted: [], contexts: [], appended: [], session: 's1', messages: [], verifyOut: '' }
  mock.env(on, {})
  w.clock = mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: w.session }))
  on('session.messages', () => ({ value: w.messages.map(m => ({ ...m, toolUses: [] })) }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\nguidance' }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (String(e.argv[1]).endsWith('/helper/resolve.py')) {
      const req = JSON.parse(e.init?.stdin ?? '{}') as { items: { id: string; ref: string; display: string | null }[] }
      const out = req.items.map(it => ({ ...resolveOne(it.ref, it.display), id: it.id, ...(w.lines && it.ref === 'pages.jsonl#L3' ? { window: w.lines } : {}) }))
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (/verify\/v-\w+\.py$/.test(String(e.argv[1])) && w.verifyOut) return { value: { exitCode: 0, stdout: w.verifyOut, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: 'no such script', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    w.contexts.push(e.context ?? [])
    return { text: e.text } as never
  })
  on('prompt.fill', ($, e) => ({ isFilled: true, text: e.text, cursor: e.text.length }) as never)
  on('agent.spawn', ($, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description, subagentType: e.subagentType ?? (e as { subagent_type?: string }).subagent_type })
    return { model: 'm', agentId: `agent-${w.spawned.length}` }
  })
  on('ui.open', ($, e) => {
    w.opened.push({ id: e.id, focus: (e as { focus?: boolean }).focus })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

type M = Mounted<'terminal'>
// the element holding the one keyed `key`: a footer's row of buttons
type Node = { key?: string; props?: { key?: string; children?: unknown }; children?: unknown }
function rowOf(tree: unknown, key: string): Node | undefined {
  const kids = (n: Node): Node[] => [n.children, n.props?.children].flatMap(x => (Array.isArray(x) ? x : x ? [x] : [])).filter(x => x && typeof x === 'object') as Node[]
  const walk = (n: Node): Node | undefined => (kids(n).some(c => c.key === key || c.props?.key === key) ? n : kids(n).map(walk).find(Boolean))
  return walk(tree as Node)
}
const MESSAGE = (text: string, requestId = 'm1') => ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never
const PRESS = { button: 'left', shift: false, ctrl: false, alt: false, type: 'press' }

/** Every row the mod appends to a conversation, kept in `w.appended`. */
function keepAppends(on: On, w: World): void {
  on('session.append', ($, e) => {
    const text = (e.message.content as { type?: string; text?: string }[]).map(b => b.text ?? '').join('')
    w.appended.push({ type: e.message.type, text })
    return { uuid: e.uuid } as never
  })
}

/** A text row of main's reply, as the engine stores it (the kit stores none: its rejection is expected). */
function appendRow($: { session: { append: (args: never) => Promise<unknown> } }, uuid: string, text: string): Promise<unknown> {
  return $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
}

type ParaProps = { cols: number; block: Parameters<typeof blockLayout>[0]; chips: ChipView[]; raws: string[] }

/** The props a paragraph's Client (para.tsx) is drawn with: its block, and a chip per citation. */
async function para(ui: M, key: string): Promise<ParaProps> {
  const el = (await ui.find({ key })) as { type?: string; props?: { props?: ParaProps } } | undefined
  if (el?.type !== 'Client' || !el.props?.props) throw new Error(`no paragraph Client ${key}`)
  return el.props.props
}

/** Click the n-th citation of a paragraph: a left press and release on its first cell, as the person does. */
async function clickCite(ui: M, key: string, n = 0): Promise<void> {
  const p = await para(ui, key)
  const span = blockLayout(p.block, p.chips, p.cols, -1).spans.find(sp => sp.chip === n)!
  await ui.pointer({ type: 'down', x: span.x0, y: span.line, button: 'left', in: key } as never)
  await ui.pointer({ type: 'up', x: span.x0, y: span.line, button: 'left', in: key } as never)
}

/** The key of a citation's claim in a row of a reply. */
function claimOf(text: string, row: string, raw: string): string {
  return claimsIn(text, row).find(cl => cl.c.raw === raw)!.key
}

// ------------------------------------------------------------------------------------------------ display

test('a citation is a blue underlined link; a problem is red; ◌ while it is worked on, then ✓, or × and red', () => {
  expect(chipState('ok', undefined)).toBe('link')
  expect(chipState('unchecked', undefined)).toBe('link')
  expect(chipState(undefined, undefined)).toBe('link')
  expect(chipState('differs', undefined)).toBe('problem')
  expect(chipState('missing', undefined)).toBe('problem')
  expect(chipState('differs', 'fixing')).toBe('fixing')
  expect(chipState('differs', 'failed')).toBe('failed')
  expect(chipState('ok', 'failed')).toBe('link')
  expect(chipState('ok', undefined, 'refuted')).toBe('failed')
  expect(chipLook('ok', undefined, 'verified')).toEqual({ state: 'link', mark: '✓', spin: false })
  expect(chipLook('ok', undefined, 'refuted')).toEqual({ state: 'failed', mark: '×', spin: false })
  expect(chipLook('ok', undefined, 'running')).toEqual({ state: 'link', mark: '', spin: true })
  expect(chipLook('ok', undefined, 'asked')).toEqual({ state: 'link', mark: '', spin: true })
  expect(chipLook('ok', undefined, 'error')).toEqual({ state: 'failed', mark: '×', spin: false })
  expect(chipLook('ok', undefined, 'missing')).toEqual({ state: 'failed', mark: '×', spin: false })
  expect(chipLook('differs', 'fixing', undefined)).toEqual({ state: 'fixing', mark: '', spin: true })
  expect(chipLook('differs', 'failed', undefined)).toEqual({ state: 'failed', mark: '×', spin: false })
  const link = chipSegs({ label: '412', state: 'link', mark: '', spin: false, tip: '' }, false)
  expect(link).toEqual([{ s: '412', fg: COLORS.link, u: true }])
  expect(link[0]!.bg).toBe(undefined)
  // under the pointer in inverse: its blue becomes the background
  expect(chipSegs({ label: '412', state: 'link', mark: '', spin: false, tip: '' }, true)).toEqual([{ s: '412', fg: COLORS.link, u: true, inv: true }])
  expect(chipSegs({ label: '412', state: 'problem', mark: '', spin: false, tip: '' }, false)[0]!.fg).toBe(COLORS.problem)
  const spin = chipSegs({ label: '412', state: 'fixing', mark: '', spin: true, tip: '' }, false, 3)
  expect(spin[1]).toEqual({ s: ` ${SPIN}`, fg: COLORS.problem })
  const failed = chipSegs({ label: '412', state: 'failed', mark: '×', spin: false, tip: '' }, false)
  expect(failed).toEqual([{ s: '412', fg: COLORS.problem, u: true }, { s: '×', fg: COLORS.problem }])
  expect(chipSegs({ label: '412', state: 'link', mark: '✓', spin: false, tip: '' }, false)[1]).toEqual({ s: '✓' })
  expect(JSON.stringify([link, spin, failed])).not.toMatch(/fix|corrected/)
})

test('a press between words finds its sentence, citations kept; a full stop inside a citation ends none', () => {
  const block = parseReply('First one [[3.5|a.csv#row=2]] here. Second [[7|b.json#/x]] there.')[0] as Parameters<typeof paraLayout>[0]
  const lay = paraLayout(block, [], 80, -1)
  expect(sentenceAt(lay.source, 0)).toBe('First one [[3.5|a.csv#row=2]] here.')
  const second = lay.words.find(w => lay.source.slice(w.at).startsWith('there'))!
  expect(passageAt(lay, second.x0, second.line)).toEqual({ kind: 'sentence', text: 'Second [[7|b.json#/x]] there.' })
})

// ------------------------------------------------------------------------------------------------ fix rounds, pure

test('fix items: one per sentence however many of its citations fail; a card by its embed line', () => {
  const [c1, c2] = citations(BAD)
  const items = fixItems(REPLY, [
    { cite: c1!, why: 'the card shows 1013, not 1014' },
    { cite: c2!, why: 'does not resolve' },
    { card: 'zz9', why: 'no card zz9' },
  ])
  expect(items.length).toBe(2)
  expect(items[0]).toEqual({ old: BAD, problems: [{ raw: c1!.raw, why: 'the card shows 1013, not 1014' }, { raw: c2!.raw, why: 'does not resolve' }], cites: [c1!.raw, c2!.raw] })
  expect(items[1]).toEqual({ old: '[[card:zz9]]', problems: [{ raw: '[[card:zz9]]', why: 'no card zz9' }], cites: [], card: 'zz9' })
  const prompt = fixPrompt(items)
  expect(prompt).toContain(`1. ${BAD}`)
  expect(prompt).toContain('2. [[card:zz9]]\n   no card zz9')
  expect(prompt).toContain('`<n>: CANNOT <why>`')
  expect(prompt).toContain('Give a sentence whole, rewritten so that every word of it agrees with the corrected values')
})

test("a fix item is the citation's whole sentence: within its line, without the list marker, a full stop inside a citation ends none", () => {
  const text = ['Intro line.', '- Agent 3 made the most. It deleted [["Seite gelöscht. Neu."|events.jsonl#L4]] twice, about a third.', '| dse | [[9|a.csv#row=2]] |'].join('\n')
  const [quote, cell] = citations(text)
  expect(sentenceIn(text, quote!.raw)).toBe('It deleted [["Seite gelöscht. Neu."|events.jsonl#L4]] twice, about a third.')
  expect(sentenceIn(text, cell!.raw)).toBe('| dse | [[9|a.csv#row=2]] |')
  expect(fixItems(text, [{ cite: quote!, why: 'no' }])[0]!.old).toBe('It deleted [["Seite gelöscht. Neu."|events.jsonl#L4]] twice, about a third.')
})

test('the fix answer: one line per item, CANNOT, a missing line, backticks and quotes', () => {
  const got = parseFix(['Here you go:', `\`1: ${FIXED}\``, '2. CANNOT the card has no such row', '4: stray'].join('\n'), 3)
  expect(got[0]).toEqual({ ok: true, text: FIXED })
  expect(got[1]).toEqual({ ok: false, why: 'the card has no such row' })
  expect(got[2]).toEqual({ ok: false, why: 'the fix gave no corrected text' })
  expect(parseFix('1: "quoted text"', 1)[0]).toEqual({ ok: true, text: 'quoted text' })
})

test('a corrected sentence replaces the old one whole, unmarked, in its own row only; a card embed stays alone on its line; $ is kept', () => {
  const out = applyCorrections(REPLY, [{ old: BAD, new: 'probier costs $1 or [[1013|card:abc123#revisions/probier]].', at: 1, row: 'r1' }, { old: '[[card:abc123]]', new: '[[card:def456]]', at: 1, row: 'r1' }], 'r1')
  expect(out.split('\n').at(-1)).toBe('probier costs $1 or [[1013|card:abc123#revisions/probier]].')
  expect(out.split('\n')[0]).toBe('[[card:def456]]')
  expect(applyCorrections(REPLY, [{ old: BAD, new: FIXED, at: 1, row: 'r1' }], 'r1')).toBe(REPLY.replace(BAD, FIXED))
  // a later answer with the same sentence keeps what it says
  expect(applyCorrections(REPLY, [{ old: BAD, new: FIXED, at: 1, row: 'r1' }], 'r2')).toBe(REPLY)
})

test('a claim is a citation in its sentence and answer: the same citation elsewhere is another claim', () => {
  const raw = '[[06:02|revisions.jsonl#L6149]]'
  const a = `dse got its first edit at ${raw}. Then more.`
  const b = `The fractal wiki got its first edit at ${raw}.`
  const ka = claimOf(a, 'r1', raw)
  expect(claimsIn(a, 'r1')[0]!.sentence).toBe(`dse got its first edit at ${raw}.`)
  expect(claimOf(b, 'r2', raw)).not.toBe(ka)
  expect(claimOf(a, 'r2', raw)).not.toBe(ka)
  expect(claimOf(`Intro. ${a}`, 'r1', raw)).toBe(ka)
  // a table's claim is its row
  expect(claimsIn('| w | n |\n|---|---|\n| dse | [[9|a.csv#row=2]] |', 'r1')[0]!.sentence).toBe('dse | [[9|a.csv#row=2]]')
})

// ------------------------------------------------------------------------------------------------ the flow

test('a fix round settles each item: a correction that checks is drawn, one that does not stays red with why', () => {
  const [c1] = citations(BAD)
  const items = fixItems(REPLY, [{ cite: c1!, why: 'the card shows 1013, not 1014' }, { card: 'zz9', why: 'no card zz9' }])
  const verdict = (raw: string) => (raw.startsWith('[[1013|') ? { status: 'ok', why: 'the card shows 1013' } : raw.startsWith('[[1015|') ? { status: 'differs', why: 'the card shows 1013, not 1015' } : undefined)
  const good = settleFix(items, parseFix(`1: ${FIXED}\n2: [[card:zz8]]`, 2), verdict, id => (id === 'zz8' ? '' : 'no card'))
  expect(good.corrections).toEqual([{ old: BAD, new: FIXED }, { old: '[[card:zz9]]', new: '[[card:zz8]]' }])
  expect(good.states).toEqual([{ state: 'fixed' }, { state: 'fixed' }])
  const bad = settleFix(items, parseFix('1: probier has [[1015|card:abc123#revisions/probier]].\n2: CANNOT the script fails', 2), verdict, () => 'no card zz9')
  expect(bad.corrections).toEqual([])
  expect(bad.states[0]).toEqual({ state: 'failed', why: 'the correction still does not check ([[1015|card:abc123#revisions/probier]]: the card shows 1013, not 1015)' })
  expect(bad.states[1]).toEqual({ state: 'failed', why: 'the script fails' })
  expect(bad.notes[1]).toBe('could not fix [[card:zz9]]: the script fails')
  const bare = settleFix(items.slice(0, 1), parseFix('1: [[1013|card:abc123#revisions/probier]]', 1), verdict, () => '')
  expect(bare.corrections).toEqual([])
  expect(bare.states[0]).toEqual({ state: 'failed', why: 'the fix gave a value, not the whole sentence' })
})

test('each subagent of the mod is named for what it does', () => {
  const [c1] = citations(BAD)
  expect(fixName(fixItems(REPLY, [{ cite: c1!, why: 'x' }]))).toBe('verification · correcting citations')
  expect(fixName(fixItems(REPLY, [{ card: 'zz9', why: 'x' }]))).toBe('verification · correcting cards')
  expect(fixName(fixItems(REPLY, [{ cite: c1!, why: 'x' }, { card: 'zz9', why: 'x' }]))).toBe('verification · correcting citations and cards')
  expect(verifyName('13403')).toBe('verification · checking 13403')
  expect(threadName('Why is dse so large?')).toBe('side thread · Why is dse so large?')
  expect(threadName('Why does the dse wiki have so many more revisions than all the others combined?')).toBe('side thread · Why does the dse wiki have so many more…')
  // a general-purpose subagent standing in for a refused fork says so, and is still known as the mod's
  expect(fallbackName('side thread · why')).toBe('side thread · why · general-purpose, fork refused')
  expect(MOD_AGENT.test(fallbackName('view · building Timeline'))).toBe(true)
})

test('a side thread\'s answer is told to main in one line: what it was about, the question, the answer\'s start, its file', () => {
  const t = { id: 't1', label: 'the bar "probier: [[1013|card:abc123#revisions/probier]]"', ref: '', context: '', agentId: 'a9', engine: 'fork', file: '.thimble-cc-mod/threads/t1.md', turns: [{ q: 'how does it compare with the second card?', a: '', state: 'running', tools: 0, partial: '' }] }
  const answer = `[[card:abc123]]\n\nIt is a twelfth of dse's [[13403|card:abc123#revisions/dse]] revisions.\n\nThe second card shows ${'more words '.repeat(80)}`
  const note = threadNote(t as never, t.turns[0]!.q, answer)
  expect(note.startsWith('thimble-cc-mod: side thread answered, in the panel (the analyst read it there). It was about the bar "probier: 1013"; the analyst asked "how does it compare with the second card?", and it answered: (card:abc123) It is a twelfth of dse\'s 13403 revisions. The second card shows more words')).toBe(true)
  expect(note).toContain('… The whole exchange is in .thimble-cc-mod/threads/t1.md.')
  expect(note).not.toContain('\n')
  expect(note).not.toContain('[[')
  expect(note.length).toBeLessThan(800)
})

test('a reply with a failing citation goes to a fork of main, never as a prompt to main; refused, it is marked', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await appendRow($, 'm1', REPLY)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  expect(w.submitted).toEqual([])
  // a fork of main, which has the reply and the guidance in its conversation
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.prompt).not.toContain('# thimble-cc-mod')
  expect(w.spawned[0]?.prompt).not.toContain('The reply:')
  expect(w.spawned[0]?.description).toBe('verification · correcting citations')
  expect(w.spawned[0]?.prompt).toContain(`1. ${BAD}`)
  expect(w.spawned[0]?.prompt).toContain('[[1014|card:abc123#revisions/probier]]: the card shows 1013, not 1014')
  // the kit starts no subagent (it drops the id a hook answers): the general-purpose fallback, given the guidance and
  // the reply and named so, is refused too, and the citation stays red, × after it, its tip saying why
  expect(w.spawned[1]?.subagentType).toBe('general-purpose')
  expect(w.spawned[1]?.description).toBe('verification · correcting citations · general-purpose, fork refused')
  expect(w.spawned[1]?.prompt).toContain('# thimble-cc-mod')
  expect(w.spawned[1]?.prompt).toContain(`The reply:\n${REPLY}`)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-3'))).toContain('"state":"failed","mark":"×"')
  await clickCite(ui, 'para-3')
  await ui.unmount()
  // Markdown has no red: where no Client runs, the problem is marked × after its link
  const flat = (await $.ui.mount({ ...(MESSAGE(REPLY) as object), surface: 'vscode' } as never)) as unknown as M
  const md = (await flat.find({ type: 'Markdown', text: /^probier has/ })) as { props: { text: string } } | undefined
  expect(md?.props.text).toMatch(/^probier has \[1014\]\([^)]+\) ×, see \[pages:3\]\([^)]+\)\.$/)
  await flat.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /the fix failed: could not start a subagent/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /couldn't fix/ })).toBeUndefined()
  await pane.unmount()
})

test('corrections are drawn in place in the reply, unmarked, also in a later session', async ($, on) => {
  const w = world(on)
  // one made for this row, one from before corrections knew their row
  w.files.set(`${CWD}/.thimble-cc-mod/corrections.json`, JSON.stringify([{ old: BAD, new: FIXED, at: 1, row: 'm1' }, { old: 'dse has', new: 'DSE HAS', at: 1 }]))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const fixed = JSON.stringify(await para(ui, 'para-3'))
  expect(fixed).toContain('[[1013|card:abc123#revisions/probier]]')
  expect(fixed).not.toContain('corrected')
  expect(fixed).not.toContain('1014')
  expect(fixed).not.toContain('"state":"problem"')
  expect(JSON.stringify(await para(ui, 'para-2'))).not.toContain('DSE HAS')
  await ui.unmount()
  // a later answer that says the same keeps what it says
  const later = (await $.ui.mount(MESSAGE(REPLY, 'm2'))) as unknown as M
  expect(JSON.stringify(await para(later, 'para-3'))).toContain('[[1014|card:abc123#revisions/probier]]')
  await later.unmount()
})

test('a verification script is asked of a fork of main, never as a prompt to main', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2') // dse's 13403
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  expect(w.submitted).toEqual([])
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.description).toBe('verification · checking 13403')
  expect(w.spawned[1]).toMatchObject({ subagentType: 'general-purpose', description: 'verification · checking 13403 · general-purpose, fork refused' })
  expect(w.spawned[0]?.prompt).toContain(`verification script of ${dse.raw}`)
  expect(w.spawned[0]?.prompt).toContain(`from the sentence "dse has ${dse.raw} of`)
  expect(w.spawned[0]?.prompt).toMatch(/Write it at \.thimble-cc-mod\/verify\/v-\w+\.py/)
  expect(await pane.find({ type: 'Text', text: /could not start a subagent/ })).toBeDefined()
  // the panel names the script by what it does, not by its file's id
  expect(JSON.stringify(await pane.drawn())).not.toContain('verify/v-')
  // its title row: the cited value, what checking found, and its controls, which never give way, against the right edge
  expect(await pane.find({ key: 'cite-title' })).toBeDefined()
  await pane.unmount()
})

test("a row of main's chat that a subagent of the mod causes is one dim line", async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const note = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "side thread · why is dse so large?" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-x', status: 'completed' } } } as never)) as unknown as M
  expect(await note.find({ type: 'Text', text: /^ {2}a thimble-cc-mod subagent · finished/ })).toBeDefined()
  await note.unmount()
  // one the mod stopped says so; expanded (ctrl+o) the engine draws the notice whole
  const NOTE = { plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u3', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "side thread · why" was stopped', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-x', status: 'killed' } } }
  const stopped = (await $.ui.mount(NOTE as never)) as unknown as M
  expect(await stopped.find({ type: 'Text', text: /^ {2}a thimble-cc-mod subagent · stopped/ })).toBeDefined()
  await stopped.unmount()
  const whole = (await $.ui.mount({ ...NOTE, props: { ...NOTE.props, isExpanded: true } } as never)) as unknown as M
  expect(await whole.find({ type: 'Text', text: /the engine row/ })).toBeDefined()
  await whole.unmount()
  const other = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u2', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "explore" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-y', status: 'completed' } } } as never)) as unknown as M
  expect(await other.find({ type: 'Text', text: /the engine row/ })).toBeDefined()
  await other.unmount()
  const row = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'ToolUse', requestId: 'tu1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'tu1', tool: 'Agent', input: { description: 'verification · correcting citations', prompt: 'x' }, isRunning: true, isErrored: false, isInterrupted: false } } as never)) as unknown as M
  expect(await row.find({ type: 'Text', text: /^ {2}verification · correcting citations · running/ })).toBeDefined()
  await row.unmount()
})

test('a verification is drawn on its citation: ◌ while it runs, × and red when it recomputed another value, else ✓', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const key = claimOf(REPLY, 'm1', dse.raw)
  const script = `${CWD}/.thimble-cc-mod/verify/v-${key}.py`
  let ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2')
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  w.files.set(script, 'print("RESULT: 13400")')
  w.verifyOut = 'RESULT: 13400\n'
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-2'))).toContain('"label":"13403","state":"failed","mark":"×","spin":false')
  await ui.unmount()
  w.verifyOut = 'RESULT: 13403\n'
  const again = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  await again.press({ key: 'rerun' })
  await again.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-2'))).toContain('"label":"13403","state":"link","mark":"✓","spin":false')
  await ui.unmount()
  // the same citation in another sentence of a later answer is not verified by this one
  const other = 'The probier wiki has [[13403|card:abc123#revisions/dse]] revisions.'
  const later = (await $.ui.mount(MESSAGE(other, 'm2'))) as unknown as M
  expect(JSON.stringify(await para(later, 'para-1'))).toContain('"label":"13403","state":"link","mark":"","spin":false')
  await clickCite(later, 'para-1')
  await later.unmount()
  const cite = (await $.ui.mount(PANE)) as unknown as M
  await cite.press({ key: 'verify' })
  await cite.unmount()
  const asked = w.spawned.filter(s => s.description === 'verification · checking 13403').at(-1)!
  expect(asked.prompt).toContain(`from the sentence "${other}"`)
  expect(asked.prompt).not.toContain(`Write it at ${script.slice(CWD.length + 1)}`)
  // the fork's conversation does not hold the notes main has not read yet: they lead its prompt
  expect(asked.prompt.startsWith('Notes thimble-cc-mod left for the main conversation since its last prompt:\nthimble-cc-mod: the verification script')).toBe(true)
})

// ------------------------------------------------------------------------------------------------ words that show no value

const REVS = '[[its revisions|revisions.jsonl#L5603-L5625]]'
const REVS_REF = 'revisions.jsonl#L5603-L5625'

test('a verification of link words that show no value is compared with the place they name', () => {
  expect(showsValue('13403')).toBe(true)
  expect(showsValue('91%')).toBe(true)
  expect(showsValue('"answered wrong"')).toBe(true)
  expect(showsValue('its revisions')).toBe(false)
  expect(showsValue('13,403 revisions')).toBe(false)
  expect(showsValue(null)).toBe(false)
  expect(citedPlace(REVS_REF)).toBe('L5603-L5625')
  expect(citedPlace('pages.jsonl')).toBe('')
  expect(citedPlace('card:abc123#revisions/dse')).toBe('')
  // the same lines, however the script writes them; never other lines, a part of them, or a bare number
  for (const r of ['L5603-L5625', 'revisions.jsonl#L5603-L5625', 'lines 5603-5625', 'L5603–L5625']) expect(placeIn(REVS_REF, r)).toBe(true)
  for (const r of ['L5603-L5624', 'L5603', 'L100-L120', '5603-5625', '23']) expect(placeIn(REVS_REF, r)).toBe(false)
  expect(placeIn('pages.jsonl#L3', 'L3')).toBe(true)
  expect(placeIn('pages.jsonl#L3', 'L3-L3')).toBe(true)
  expect(placeIn('t.csv#row=12', 'row 12')).toBe(true)
  expect(placeIn('t.csv#row=12', 'row=120')).toBe(false)
  expect(placeIn('r.json#/runs/3', '/runs/3')).toBe(true)
  // the words that show no value match by their place (or the words themselves); a value only by its value
  expect(verifyMatches('its revisions', REVS_REF, 'L5603-L5625')).toBe(true)
  expect(verifyMatches('its revisions', REVS_REF, 'L100-L120')).toBe(false)
  expect(verifyMatches('Main', 'pages.jsonl#L3', 'Main')).toBe(true)
  expect(verifyMatches('13403', 'card:abc123#revisions/dse', '13403')).toBe(true)
  expect(verifyMatches('5', 'pages.jsonl#L5', 'L5')).toBe(false)
  expect(verifyMatches(null, REVS_REF, 'anything')).toBe(true)
  expect(citedAs('its revisions', REVS_REF)).toBe('L5603-L5625')
  expect(citedAs('13403', 'card:abc123#revisions/dse')).toBe('13403')
  expect(citedAs('the probier bar', 'card:abc123#revisions/probier')).toBe('the probier bar')
  // what the script is asked to print: the value, or the place of the records the sentence describes
  expect(scriptAim('13403', 'card:abc123#revisions/dse')).toBe('recomputes 13403 from the raw files')
  expect(scriptAim('its revisions', REVS_REF)).toBe('finds in the raw files the records that show what the sentence claims and ends with `RESULT: <their place>`, written as L<first>-L<last>')
  expect(scriptAim('the row', 't.csv#row=12')).toContain('written as row=<n>')
  const p = reportVerifyPrompt({ title: 'T', file: 'r.md', heading: 'Four labels take turns', items: [{ key: 'k1', raw: REVS, display: 'its revisions', sentence: `Four labels take turns in ${REVS}.`, script: '.thimble-cc-mod/verify/v-k1.py' }] })
  expect(p).toContain('write a standalone script at .thimble-cc-mod/verify/v-k1.py that finds in the raw files the records that show what the sentence claims and ends with `RESULT: <their place>`, written as L<first>-L<last>, following')
})

test('a verification that recomputed the place link words name is ✓; another place is × and names the cited lines', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const text = `Four labels take turns in ${REVS}.`
  const key = claimOf(text, 'm1', REVS)
  const script = `${CWD}/.thimble-cc-mod/verify/v-${key}.py`
  const notes = () => (JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/notes.json`) ?? '{"notes": []}') as { notes: string[] }).notes
  let ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  await w.clock!.advance(200) // its citation is checked
  await clickCite(ui, 'para-1')
  await ui.unmount()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  // the head says the place resolves, once: not that a value went unchecked, nor the resolver's reason again
  expect(await pane.find({ type: 'Text', text: /^( {2})?the place resolves$/ })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).not.toContain('not checked')
  await pane.press({ key: 'verify' })
  const asked = w.spawned.find(s => s.description === 'verification · checking its revisions')!
  expect(asked.prompt).toContain('"its revisions" names a place, not a value: the script finds in the raw files the records that show what the sentence claims and ends with `RESULT: <their place>`, written as L<first>-L<last>.')
  w.files.set(script, 'print("RESULT: L5603-L5625")')
  w.verifyOut = 'revisions of Main: 23\nRESULT: L5603-L5625\n'
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^✓ the script recomputed L5603-L5625, as cited$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^( {2})?the place resolves, and the verification recomputed it$/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-1'))).toContain('"label":"its revisions","state":"link","mark":"✓","spin":false')
  await ui.unmount()
  expect(notes().at(-1)).toContain(`recomputed L5603-L5625 for ${REVS} in "${text}", which matches.`)
  expect(notes().join('\n')).not.toContain('not its revisions')
  // a script that found the records elsewhere refutes the citation, and says which lines it cites
  w.verifyOut = 'RESULT: L100-L120\n'
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^× the script recomputed L100-L120, the reply cites L5603-L5625$/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-1'))).toContain('"label":"its revisions","state":"failed","mark":"×","spin":false')
  await ui.unmount()
  expect(notes().at(-1)).toContain('recomputed L100-L120 for')
  expect(notes().at(-1)).toContain(', not L5603-L5625.')
})

test("the citation panel's head is never cut: what checking found wraps below the citation when it does not fit beside it", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await w.clock!.advance(200) // its citations are checked
  await clickCite(ui, 'para-2')
  await ui.unmount()
  // the innermost Text that says it: beside the value on the title row, or a row of its own under it
  const said = async (p: M) => {
    const all = (await p.findAll({ type: 'Text', text: /the value is at the place/ })) as { props: { wrap?: string }; children?: unknown[] }[]
    return all.find(t => (t.children ?? []).every(c => typeof c === 'string'))
  }
  const wide = (await $.ui.mount(PANE)) as unknown as M
  expect(await said(wide)).toMatchObject({ children: ['  the value is at the place'] })
  await wide.unmount()
  const narrow = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 50, rows: 30 }, props: { bodyColumns: 30, bodyRows: 28 } } as never)) as unknown as M
  expect(await said(narrow)).toMatchObject({ props: { wrap: 'wrap' }, children: ['the value is at the place'] })
  await narrow.unmount()
})

// ------------------------------------------------------------------------------------------------ verification failures

test('a verification script that crashes or is never written fails: × and red, and the panel says why', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const key = claimOf(REPLY, 'm1', dse.raw)
  const script = `${CWD}/.thimble-cc-mod/verify/v-${key}.py`
  let ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2')
  await ui.unmount()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  // never written: run it, and there is no script
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^× not written: there is no script$/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-2'))).toContain('"label":"13403","state":"failed","mark":"×","spin":false')
  await ui.unmount()
  // written, and it crashes (the engine's process.run answers exit 1, "no such script")
  w.files.set(script, 'import nope')
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^× crashed: the script exited with 1 \(no such script\)/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-2'))).toContain('"label":"13403","state":"failed","mark":"×","spin":false')
  await clickCite(ui, 'para-2')
  await ui.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^× crashed: / })).toBeDefined()
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ long citations

test('a long quoted citation shows whole, its words wrapping like the words around it, each piece the one link', () => {
  const quote = '"answered wrong before discovering proxy settings in the second week"'
  const block = parseReply(`The agent [[${quote}|events.jsonl#L4]] and then stopped.`)[0] as Parameters<typeof paraLayout>[0]
  const chips: ChipView[] = [{ label: quote, state: 'link', mark: '✓', spin: false, tip: '' }]
  const lay = paraLayout(block, chips, 30, -1)
  const lines = lay.lines.map(l => l.map(x => x.s).join(''))
  expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(`The agent ${quote}✓ and then stopped.`)
  expect(lines.every(l => l.length <= 30)).toBe(true)
  const mine = lay.spans.filter(x => x.chip === 0)
  expect(mine.length).toBeGreaterThan(1)
  // every cell a span covers is the link's, underlined
  for (const sp of mine) {
    let x = 0
    for (const seg of lay.lines[sp.line]!) {
      for (const _ of seg.s) {
        if (x >= sp.x0 && x < sp.x1 && seg.s !== '✓') expect(seg.u).toBe(true)
        x++
      }
    }
  }
  // punctuation right after a citation wraps with it, never alone at a line's start
  const glued = paraLayout(parseReply('aaaa bbbb [[12345|x.csv#row=1]], cc')[0] as Parameters<typeof paraLayout>[0], [], 15, -1)
  expect(glued.lines.map(l => l.map(x => x.s).join(''))).toEqual(['aaaa bbbb', '12345, cc'])
  // hovering any piece lights the whole citation
  const lit = paraLayout(block, chips, 30, 0)
  expect(lit.lines.flat().filter(x => x.inv).map(x => x.s).join(' ').replace(/\s+/g, ' ')).toBe(quote)
  // in a narrow table the quote wraps in its column, the citation never left out
  const table = parseReply(['| who | said |', '|---|---|', `| a1 | [[${quote}|events.jsonl#L4]] |`].join('\n'))[0] as Parameters<typeof blockLayout>[0]
  const tl = blockLayout(table, chips, 32, -1)
  expect(tl.lines.every(l => lineWidth(l) <= 32)).toBe(true)
  expect(tl.lines.map(l => l.map(x => x.s).join('')).join(' ').replace(/\s+/g, ' ')).toContain(`a1 ${quote.slice(0, 10)}`)
  expect(tl.lines.flat().map(x => x.s).join('').replace(/\s+/g, '')).toContain(`${quote.replace(/\s+/g, '')}✓`)
  expect(new Set(tl.spans.filter(x => x.chip === 0).map(x => x.line)).size).toBeGreaterThan(1)
  // the column names (bold, a rule under them) take a line each; the row takes the rest
  expect(tl.rows!.filter(r => r.includes('a1')).length).toBe(tl.lines.length - 2)
  expect(tl.rows![1]).toBe('')
  expect(tl.lines[0]!.filter(x => x.s.trim()).every(x => x.b)).toBe(true)
  expect(tl.lines[1]!.filter(x => x.s.trim()).map(x => [x.s.replace(/─/g, '-'), x.fg])).toEqual([['---', COLORS.rule], ['-'.repeat(lineWidth(tl.lines[1]!) - 5), COLORS.rule]])
})

// ------------------------------------------------------------------------------------------------ quoted values with brackets

const CODE = '[["counts[\\"dse\\"] += 100"|call:1rqiqz8#L2]]'

test('a quoted value may hold brackets, as code and JSON do: the citation is read whole, its sentence kept, nothing shown raw', () => {
  const text = `Line 6 of the script does it: ${CODE}. The verification recounted.`
  expect(citations(text)).toEqual([{ raw: CODE, ref: 'call:1rqiqz8#L2', display: '"counts[\\"dse\\"] += 100"' }])
  const blocks = parseReply(text)
  expect(blocks.length).toBe(1)
  const runs = blocks[0]!.type === 'rich' ? blocks[0]!.runs : []
  expect(runs.filter(r => r.cite).map(r => r.cite!.raw)).toEqual([CODE])
  expect(runs.filter(r => !r.cite).map(r => r.text).join('')).toBe('Line 6 of the script does it: . The verification recounted.')
  expect(claimsIn(text, 'm1')[0]!.sentence).toBe(`Line 6 of the script does it: ${CODE}.`)
  expect(sentenceAt('It reads [["a[0]. b]]"|f.md#L1]] there. Next.', 3)).toBe('It reads [["a[0]. b]]"|f.md#L1]] there.')
  // a JSON list, a bar, stars and underscores inside a quote; a citation after a bare one; a stray [[ takes nothing
  expect(citations('[["[[1, 2], [3]]"|data.json#/edges]]')[0]).toMatchObject({ display: '"[[1, 2], [3]]"', ref: 'data.json#/edges' })
  expect(citations('[["a || b"|f.md#L1]]')[0]).toMatchObject({ display: '"a || b"', ref: 'f.md#L1' })
  expect(citations('see [[a.md#L1]] then [["x[0]"|b.md#L2]].').map(c => c.raw)).toEqual(['[[a.md#L1]]', '[["x[0]"|b.md#L2]]'])
  expect(citations('write [[ to open one; [[5|a.md#L1]] and [[a.md#L2]].').map(c => c.raw)).toEqual(['[[5|a.md#L1]]', '[[a.md#L2]]'])
  expect(citations('no [[place]] and [[x|]] or [[x|a[1]]] cites').map(c => c.raw)).toEqual(['[[place]]'])
  expect(citations('`[["x[0]"|f.md#L1]]` is code')).toEqual([])
  const styled = inlineRuns('[["a_b *c*"|f.md#L1]] and **in bold [["d[1]"|f.md#L2]]**')
  expect(styled.map(r => [r.text, Boolean(r.b), r.cite?.display ?? null])).toEqual([
    ['"a_b *c*"', false, '"a_b *c*"'],
    [' and ', false, null],
    ['in bold ', true, null],
    ['"d[1]"', true, '"d[1]"'],
  ])
  // in a table, a quote's bars and brackets stay in its cell, and an escaped bar is the citation's own
  expect(tableCells('| [["x[1] | y"|f.md#L1]] | [[13403\\|card:abc123#revisions/dse]] |')).toEqual(['[["x[1] | y"|f.md#L1]]', '[[13403|card:abc123#revisions/dse]]'])
  // a side thread's call:none citation is pinned to the output that holds the quote
  const pinned = pinCalls('It does [["counts[\\"x\\"]"|call:none#L1]].', [{ id: 'k9', output: 'counts[\\"x\\"] = 1' }], () => false)
  expect(pinned).toBe('It does [["counts[\\"x\\"]"|call:k9#L1]].')
})

test('a paragraph line that opens with an indented "# " is read as a paragraph, not left unread', () => {
  const blocks = parseReply('The script says:\n    # adds 100 on purpose [[5|a.md#L1]]\n\nNext.')
  expect(blocks.map(b => b.type)).toEqual(['md', 'rich', 'md'])
  expect(blocks[1]!.type === 'rich' && blocks[1]!.runs.some(r => r.cite?.raw === '[[5|a.md#L1]]')).toBe(true)
})

test('a streaming citation whose quote holds brackets waits until it closes, then shows as a link', () => {
  const look = { link: (c: { display: string | null; ref: string }) => `<${c.display ?? c.ref}>`, card: (id: string) => `▍ card ${id}` }
  const st = streaming()
  const pieces = ['It does ', '[["counts[\\"d', 'se\\"] += 1', '00"|call:1rqiqz8#L2', ']] here.']
  const outs = pieces.map(p => streamStep(st, p, false, look))
  expect(outs.slice(0, 4).join('')).toBe('It does ')
  outs.push(streamStep(st, '', true, look))
  expect(outs.join('')).toBe('It does <"counts[\\"dse\\"] += 100"> here.')
})

// ------------------------------------------------------------------------------------------------ while a reply streams

test('a streaming reply shows each citation as a link, never its raw spelling; an unclosed one waits; a card line is a placeholder', () => {
  const look = { link: (c: { display: string | null; ref: string }) => `<${c.display ?? c.ref}>`, card: (id: string) => `▍ card ${id}` }
  const st = streaming()
  const pieces = ['dse has [[134', '03|card:abc123#revisions/dse]] rev', 'isions.\n[[card:ab', 'c123]]\n| a | [[1|x.csv#row=1]] |\n```\n[[raw|kept]]\n```\nsee `[[a|b]]` and [', '[2|y.json#/a]]']
  const outs = pieces.map(p => streamStep(st, p, false, look))
  expect(outs[0]).toBe('dse has ')
  expect(outs[2]).toBe('isions.\n')
  outs.push(streamStep(st, '', true, look))
  expect(outs.join('')).toBe('dse has <13403> revisions.\n▍ card abc123\n| a | <1> |\n```\n[[raw|kept]]\n```\nsee `[[a|b]]` and <2>')
  expect(st.raw).toBe(pieces.join(''))
  // an unclosed citation at the block's end is handed over as written
  const open = streaming()
  expect(streamStep(open, 'cut [[12|a.csv', false, look)).toBe('cut ')
  expect(streamStep(open, '', true, look)).toBe('[[12|a.csv')
  expect(streamLink({ raw: '', display: '"a [b]_c"', ref: 'p.jsonl#L2' }, 'file:///w/p.jsonl')).toBe('["a \\[b\\]\\_c"](file:///w/p.jsonl)')
})

test('while main streams, the engine is handed links and placeholders; the row is stored as written; the answer file holds the answer alone', async ($, on) => {
  const w = world(on)
  const stored: string[] = []
  let chunks: { kind: string; index?: number; text?: string; id?: string; name?: string }[] = []
  on('turn.step', async function* ($, e) {
    for (const c of chunks) yield c as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  // the kit stores no row (nothing beneath answers session.append, and an answer without next is skipped): the test
  // reads what reaches the bottom, and the append's rejection is expected
  on('session.append', ($, e, next) => {
    for (const b of e.message.content as { type: string; text?: string }[]) if (b.type === 'text') stored.push(b.text!)
    return next(e)
  })
  const step = async (index: number) => {
    const got: { kind: string; index: number; text?: string }[] = []
    for await (const c of $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 } as never)) got.push(c as never)
    return got
  }
  const append = (uuid: string, content: unknown[]) =>
    $.session.append({ message: { type: 'assistant', role: 'assistant', content }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  chunks = [{ kind: 'text', index: 0, text: 'Reading the four files.' }, { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }]
  const first = await step(0)
  expect(first.map(c => c.kind)).toEqual(['text', 'tool'])
  await append('r1', [{ type: 'text', text: first[0]!.text }])
  await append('r2', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }])
  // the reply arrives in pieces cut inside its citations and its card line
  const cuts = [3, 11, 40, 47, 70, 95]
  chunks = cuts.map((at, i) => ({ kind: 'text', index: 0, text: REPLY.slice(at, cuts[i + 1]) }))
  chunks.unshift({ kind: 'text', index: 0, text: REPLY.slice(0, 3) })
  chunks.push({ kind: 'stop', stopReason: 'end_turn', usage: null } as never)
  const second = await step(1)
  const shown = second.filter(c => c.kind === 'text').map(c => c.text).join('')
  expect(second.at(-1)!.kind).toBe('stop')
  expect(shown).not.toMatch(/\[\[/)
  expect(shown.split('\n')[0]).toBe('◌ Which wikis have the most revisions?')
  expect(shown).toContain(`dse has [13403](file://${CWD}/.thimble-cc-mod/cards/abc123.json) of [14416](file://${CWD}/.thimble-cc-mod/cards/abc123.json) revisions.`)
  expect(shown).toContain(`see [pages:3](file://${CWD}/pages.jsonl).`)
  await append('r3', [{ type: 'text', text: shown }])
  expect(stored.at(-1)).toBe(REPLY)
  await $.turn.complete({ turnId: 't1', answer: shown, durationMs: 5, reason: 'answer' } as never)
  const saved = [...w.files.entries()].filter(([k]) => k.includes('/.thimble-cc-mod/answers/'))
  expect(saved.length).toBe(1)
  expect(saved[0]![1]).toBe(`# which wiki?\n\n${REPLY}\n`)
  expect(saved[0]![1]).not.toContain('Reading the four files.')
})

// ------------------------------------------------------------------------------------------------ fix rounds and answers

test("an answer's file and its footer follow the corrections made for its rows", async ($, on) => {
  const end = { rows: [{ id: 'm1', text: REPLY }], head: 'which wiki?' }
  expect(answerFile(end, [{ old: BAD, new: FIXED, at: 1, row: 'm1' }, { old: 'dse has', new: 'x', at: 1, row: 'm0' }])).toBe(`# which wiki?\n\n${REPLY.replace(BAD, FIXED)}\n`)
  const w = world(on)
  w.files.set(`${CWD}/.thimble-cc-mod/corrections.json`, JSON.stringify([{ old: BAD, new: FIXED, at: 1, row: 'm1' }]))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await appendRow($, 'm1', REPLY)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  // the footer counts the answer as drawn: the corrected sentence, not the red one its fix round was asked about
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  // the footer's facts, no file path: the answer is saved, but the footer does not name its file
  expect(await ui.find({ type: 'Text', text: /^4 citations · 1 card$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /saved as/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /problem/ })).toBeUndefined()
  // the footer asks about the whole answer in a side thread
  const ask = (await ui.find({ type: 'Button', label: 'ask about this answer ›' })) as { key?: string } | undefined
  expect(ask).toBeDefined()
  await ui.unmount()
})

test("an answer's footer keeps its problem count whole on a narrow row: its facts give way", async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await appendRow($, 'm1', REPLY)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  const ui = (await $.ui.mount({ ...(MESSAGE(REPLY) as object), viewport: { columns: 100, rows: 40 } } as never)) as unknown as M
  type El = { props: Record<string, unknown> }
  const saved = (await ui.find({ type: 'Text', text: /citations · 1 card/ })) as El | undefined
  expect(saved?.props.wrap).toBe('truncate-end')
  expect(JSON.stringify(saved)).not.toContain('problem')
  const left = (await ui.find({ key: 'footer-left:m1' })) as El | undefined
  expect(left?.props.flexShrink).toBe(0)
  expect(JSON.stringify(left)).toContain('· 1 problem')
  expect(JSON.stringify(left)).toContain(COLORS.problem)
  await ui.unmount()
})

// ------------------------------------------------------------------------------------------------ panes

test('a record panel says the place resolves, wraps the record and lights the quoted passage', async ($, on) => {
  const w = world(on)
  const long = `{"name": "Main", "body": "${'x'.repeat(10)} the quoted passage\\nis here ${'y'.repeat(200)}"}`
  w.files.set(`${CWD}/.thimble-cc-mod/cards/ex1.json`, JSON.stringify({ id: 'ex1', kind: 'example', question: 'Which records?', examples: [{ ref: 'pages.jsonl#L3', quote: 'the quoted passage is here', note: '' }] }))
  w.lines = [{ n: 2, text: '{}', hit: false }, { n: 3, text: long, hit: true }]
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'record', ref: 'pages.jsonl#L3', cardId: 'ex1', text: 'x' }, ev: PRESS }] }, { in: 'card-1-abc123' })
  await ui.unmount()
  await w.clock!.advance(200) // the queued check runs
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^( {2})?the place resolves$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /the value is/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /This citation shows no value to recompute/ })).toBeDefined()
  // the controls stand on the title row against the right edge, a block that never gives way
  const row = rowOf(await pane.drawn(), 'ask')
  expect(row?.props).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
  expect(JSON.stringify(row)).not.toContain('no value to recompute')
  const lit = await pane.find({ type: 'Text', text: /^the quoted passage\\nis here$/ })
  expect(lit).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /yyyy/ })).toBeDefined()
  await pane.unmount()
})

test('a quoted passage is found in a record as written; a long line wraps around it', () => {
  const line = '{"a": "caf\\u00e9 \\"one\\"\\nand two"}'
  expect(quoteSpan(line, 'café "one" and two')).toEqual([7, line.length - 2])
  expect(quoteSpan('plain words here', 'words')).toEqual([6, 11])
  expect(quoteSpan('nothing', 'absent')).toBe(null)
  const rows = wrapAround('a'.repeat(100) + 'HIT' + 'b'.repeat(100), [100, 103], 20, 3)
  expect(rows.length).toBe(3)
  expect(rows.some(r => r.hi && r.text.slice(r.hi[0], r.hi[1]).length > 0)).toBe(true)
  expect(rows[0]!.text.startsWith('…')).toBe(true)
})

test('a side thread about a citation, asked from its panel, shows it as its words, never its markup', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2')
  await ui.unmount()
  const cite = (await $.ui.mount(PANE)) as unknown as M
  await cite.press({ key: 'ask' })
  await cite.unmount()
  // the thread replaces the Citation view in the one panel
  expect(w.opened.map(o => o.id)).toEqual(['thimble', 'thimble'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  // its title row: what it is about, the citation as its words
  expect(await pane.find({ type: 'Text', text: /^the citation 13403$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^13403$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\[\[/ })).toBeUndefined()
  await pane.unmount()
})

test('a passage quoted inline far into a long record is shown and lit; the line kept around it', async ($, on) => {
  const w = world(on)
  const body = 'w '.repeat(1300)
  const line = `{"body": "${body}", "label": "CountyAgentX", "time": "2026-06-18"}`
  const at = line.indexOf('CountyAgentX')
  w.lines = [{ n: 3, text: line, hit: true, spans: [[at, at + 12]] } as never]
  expect(capLine({ text: line, spans: [[at, at + 12]] }).text).toContain('"label": "CountyAgentX"')
  expect(quotedWords('"CountyAgentX"')).toBe('CountyAgentX')
  expect(quotedWords('this record')).toBe('')
  const text = 'The label is [["CountyAgentX"|pages.jsonl#L3]].'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  expect((await para(ui, 'para-1')).chips.map(c => c.label)).toEqual(['"CountyAgentX"'])
  await clickCite(ui, 'para-1')
  await ui.unmount()
  await w.clock!.advance(200)
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^CountyAgentX$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^quoted: $/ })).toBeUndefined()
  await pane.unmount()
})

test('a citation of a table card lights its cell in the Citation pane, a row past the drawn ones kept in view', async ($, on) => {
  const w = world(on)
  w.files.set(`${CWD}/.thimble-cc-mod/cards/t4b1e0.json`, JSON.stringify(TABLE))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const text = 'The largest wiki, w20, has [[2220|card:t4b1e0#revisions/w20]] revisions.'
  const ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  await clickCite(ui, 'para-1')
  await ui.unmount()
  await w.clock!.advance(200) // the queued check runs
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^How many revisions does each wiki have\?$/ })).toBeDefined()
  const lit = (await pane.findAll({ type: 'Text' })).filter(t => (t as { props?: { backgroundColor?: string } }).props?.backgroundColor === COLORS.selected)
  expect(lit.map(t => JSON.stringify(t)).join('')).toContain('2220')
  // the 20th row is past the 15 a card draws: it stands in for the 15th, after the 14 before it
  expect(await pane.find({ type: 'Text', text: /^w20\b/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^w14\b/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^w15\b/ })).toBeUndefined()
  await pane.unmount()
})

test('/thimble-ask hands the keys to its pane once the prompt is empty, so a follow-up goes to the thread', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-ask', args: 'why is dse so large?' } as never)
  await w.clock!.advance(300)
  // opened with the keys when the command ran, and asked for them again after it
  expect(w.opened.filter(o => o.id === 'thimble' && o.focus).length).toBe(2)
})

test('a thread saved as data reads back for a later session; a turn its session left running is marked ended', () => {
  const t = { id: 't1', label: 'the bar "probier: 1013"', ref: '[[1013|card:abc123#revisions/probier]]', context: 'The analyst points at it.', agentId: 'a9', engine: 'fork', file: '.thimble-cc-mod/threads/t1.md', turns: [
    { q: 'what was going on here?', a: 'A burst of edits.', state: 'done', tools: 2, partial: '' },
    { q: 'and after?', a: '', state: 'running', tools: 0, partial: '' },
  ] }
  const back = parseThread(threadJson(t))
  expect(back?.agentId).toBe('')
  expect(back?.label).toBe(t.label)
  expect(back?.turns[0]).toEqual(t.turns[0])
  expect(back?.turns[1]?.state).toBe('error')
  expect(back?.turns[1]?.a).toMatch(/session ended/)
  expect(parseThread('not json')).toBe(null)
  expect(parseThread('{"id": 3}')).toBe(null)
})

// ------------------------------------------------------------------------------------------------ side threads' answers

test("a fork's line restating its task never shows: the prompt asks for none, and one written is dropped", () => {
  const t = { id: 't1', label: 'the last answer', ref: '', context: '', agentId: '', engine: 'fork', file: '.thimble-cc-mod/threads/t1.md', turns: [] }
  expect(forkPrompt(t as never, 'why stored?')).toContain('Begin with the answer itself, not a line restating the task')
  const answer = 'Yes, I checked them: [[13403|card:abc123#revisions/dse]] in both files.'
  expect(withoutTaskLine(`Task: say why the answer said "stored revisions", and whether I checked the counts.\n\n${answer}`)).toBe(answer)
  expect(withoutTaskLine(`**Task:** count deletions per wiki.\nResult: ${answer}`)).toBe(answer)
  expect(withoutTaskLine(`Scope: the probier thread.\n${answer}`)).toBe(answer)
  // the progress row's text: a Task line alone leaves nothing
  expect(withoutTaskLine("Task: count one account's deletions per wiki and per week.")).toBe('')
  // anything else stays as written
  expect(withoutTaskLine(answer)).toBe(answer)
  expect(withoutTaskLine('Tasks: three of them failed.')).toBe('Tasks: three of them failed.')
  expect(withoutTaskLine(`${answer}\nTask: later.`)).toBe(`${answer}\nTask: later.`)
  const note = threadNote({ ...t, turns: [{ q: 'why?', a: '', state: 'running', tools: 0, partial: '' }] } as never, 'why?', `Task: say why.\n\n${answer}`)
  expect(note).toContain('it answered: Yes, I checked them: 13403 in both files.')
  expect(note).not.toContain('Task:')
})

test("a side thread's fix round is given the answer, which its fork's conversation does not hold; its corrections go in place", () => {
  const body = `No agent is named there: each appears [[0|call:k3x9q1#L1]] times.\n\nThat thread dealt with totals.`
  const items = fixItems(body, [{ cite: citations(body)[0]!, why: 'line 1 of the output does not show 0' }])
  const prompt = fixPrompt(items, body)
  expect(prompt.startsWith("thimble-cc-mod: a side thread's answer, which the analyst reads in the panel, has problems the analyst sees in red.")).toBe(true)
  expect(prompt).toContain(`The answer:\n${body}\n\nIts problems:\n1. No agent is named there: each appears [[0|call:k3x9q1#L1]] times.`)
  expect(prompt).toContain('`<n>: <the corrected item>`')
  expect(fixPrompt(items)).not.toContain('The answer:')
  const fixed = 'No agent is named there: each appears [[0|.thimble-cc-mod/threads/t1.md]] times.'
  expect(correctText(body, [{ old: items[0]!.old, new: fixed }])).toBe(`${fixed}\n\nThat thread dealt with totals.`)
  expect(correctText(body, [{ old: 'not in it', new: 'x' }])).toBe(body)
})

test('a fork is given the notes main has not read yet', () => {
  expect(withNotes([], 'P')).toBe('P')
  expect(withNotes(['thimble-cc-mod: side thread answered.', 'thimble-cc-mod: a note.'], 'P')).toBe('Notes thimble-cc-mod left for the main conversation since its last prompt:\nthimble-cc-mod: side thread answered.\nthimble-cc-mod: a note.\n\nP')
})

// ------------------------------------------------------------------------------------------------ notes and resumes

test("a note for main waits for its next prompt and goes with it, never a row of main's transcript between turns", async ($, on) => {
  const w = world(on)
  keepAppends(on, w)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const key = claimOf(REPLY, 'm1', dse.raw)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2')
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  w.files.set(`${CWD}/.thimble-cc-mod/verify/v-${key}.py`, 'print("RESULT: 5217")')
  w.verifyOut = 'RESULT: 5217\n'
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  // nothing appended: a user row last in the transcript is what a resumed session answers "No response requested."
  expect(w.appended.filter(r => r.type === 'user')).toEqual([])
  const waiting = JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/notes.json`)!) as { session: string; notes: string[] }
  expect(waiting.session).toBe('s1')
  expect(waiting.notes).toHaveLength(1)
  expect(waiting.notes[0]).toContain('recomputed 5217')
  await $.prompt.submit({ text: 'and dse?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.filter(c => c.includes('recomputed 5217'))).toHaveLength(1)
  expect((JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/notes.json`)!) as { notes: string[] }).notes).toEqual([])
  // given once
  await $.prompt.submit({ text: 'and probier?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.some(c => c.includes('recomputed 5217'))).toBe(false)
})

test('a note left before the session was resumed goes with its next prompt; one of another session does not', async ($, on) => {
  const w = world(on)
  w.files.set(`${CWD}/.thimble-cc-mod/notes.json`, JSON.stringify({ session: 's1', notes: ['thimble-cc-mod: side thread answered, in the panel.'] }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: 'what did it say?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)).toContain('thimble-cc-mod: side thread answered, in the panel.')
})

test('a note of another session is not given to this one', async ($, on) => {
  const w = world(on)
  w.session = 's2'
  w.files.set(`${CWD}/.thimble-cc-mod/notes.json`, JSON.stringify({ session: 's1', notes: ['thimble-cc-mod: side thread answered, in the panel.'] }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.some(c => c.includes('side thread answered'))).toBe(false)
})

test("an answer's end and its citations' fixes and verifications are kept in marks.json as they change", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await appendRow($, 'm1', REPLY)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  let m = parseMarks(w.files.get(`${CWD}/.thimble-cc-mod/marks.json`)!)
  expect(m.last).toBe('m1')
  expect(m.ends.m1?.rows).toEqual([{ id: 'm1', text: REPLY }])
  // the fix round of the red citation could not start: failed, with why
  const bad = claimOf(REPLY, 'm1', citations(BAD)[0]!.raw)
  expect(m.fixes[bad]?.state).toBe('failed')
  const dse = claimOf(REPLY, 'm1', citations(REPLY)[1]!.raw)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await clickCite(ui, 'para-2')
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  w.files.set(`${CWD}/.thimble-cc-mod/verify/v-${dse}.py`, 'print("RESULT: 5217")')
  w.verifyOut = 'RESULT: 5217\n'
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  m = parseMarks(w.files.get(`${CWD}/.thimble-cc-mod/marks.json`)!)
  expect(m.verify[dse]).toMatchObject({ state: 'refuted', result: '5217', expected: '13403' })
})

test('after a resume, a refuted citation is red with ×, a failed fix keeps its ×, and the answer keeps its footer', async ($, on) => {
  const w = world(on)
  const dse = claimOf(REPLY, 'm1', citations(REPLY)[1]!.raw)
  const bad = claimOf(REPLY, 'm1', citations(BAD)[0]!.raw)
  const m = emptyMarks()
  setMark(m, 'ends', 'm1', { rows: [{ id: 'm1', text: REPLY }], cards: ['abc123'], file: '.thimble-cc-mod/answers/20260705-041000.md', head: 'which wiki?' })
  setMark(m, 'verify', dse, { id: dse, state: 'refuted', script: `.thimble-cc-mod/verify/v-${dse}.py`, expected: '13403', result: '5217', exitCode: 0, source: 'print("RESULT: 5217")', stdout: 'RESULT: 5217\n' })
  setMark(m, 'fixes', bad, { state: 'failed', why: 'the fix gave no corrected text' })
  m.last = 'm1'
  w.files.set(`${CWD}/.thimble-cc-mod/marks.json`, marksJson(m))
  // the resumed transcript: the question, then the answer as the model wrote it
  w.messages = [{ role: 'user', text: 'which wiki?' }, { role: 'assistant', text: REPLY }]
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock!.advance(200) // the resumed reply's citations are checked
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await para(ui, 'para-2'))).toContain('"label":"13403","state":"failed","mark":"×","spin":false')
  expect(JSON.stringify(await para(ui, 'para-3'))).toContain('"label":"1014","state":"failed","mark":"×","spin":false')
  expect(await ui.find({ type: 'Text', text: /^4 citations · 1 card$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'ask about this answer ›' } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', label: '▶ play' } as never)).toBeDefined()
  await ui.unmount()
  // the last reply's citations are the answer's own claims, which share its verifications
  await $.command.run({ command: 'thimble-cite', args: '1' } as never)
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /but the verification recomputed 5217/ })).toBeDefined()
  await pane.unmount()
  // and /thimble-play plays it
  expect(((await $.command.run({ command: 'thimble-play', args: '' } as never)) as { text?: string }).text).toBe('playing the last answer in the panel')
})

test('marks read back: a verification or fix its session left running is ended; the newest are kept', () => {
  const m = emptyMarks()
  setMark(m, 'verify', 'a', { id: 'a', state: 'running', script: 's.py', expected: '1' })
  setMark(m, 'verify', 'b', { id: 'b', state: 'verified', script: 's.py', expected: '1', result: '1' })
  setMark(m, 'fixes', 'c', { state: 'fixing' })
  setMark(m, 'fixes', 'd', { state: 'fixed' })
  const back = parseMarks(marksJson(m))
  expect(back.verify.a).toMatchObject({ state: 'error', stderr: 'the session ended before it finished' })
  expect(back.verify.b?.state).toBe('verified')
  expect(back.fixes.c).toEqual({ state: 'failed', why: 'the session ended before it finished' })
  expect(back.fixes.d).toEqual({ state: 'fixed' })
  expect(parseMarks('not json')).toEqual(emptyMarks())
  expect(parseMarks(JSON.stringify({ ends: { x: { rows: 'no' } }, verify: { y: 3 }, fixes: [], last: 4 }))).toEqual(emptyMarks())
  // set again, a mark is the newest: the cap drops the oldest
  setMark(m, 'fixes', 'c', { state: 'fixed' })
  expect(Object.keys(parseMarks(marksJson(m, 1)).fixes)).toEqual(['c'])
})

// ------------------------------------------------------------------------------------------------ round 8: Markdown and the tip

test('the model\'s Markdown is drawn as Claude Code draws it: bold bold, italic italic, inline code in the code colour, a heading bold', () => {
  const chips: ChipView[] = [{ label: '13403', state: 'link', mark: '', spin: false, tip: '' }]
  const block = parseReply('dse has **most** of the [[13403|card:abc123#revisions/dse]] *revisions*, see `pages.jsonl` and [the docs](https://example.com).')[0] as Parameters<typeof paraLayout>[0]
  const segs = paraLayout(block, chips, 120, -1).lines.flat()
  expect(segs.find(s => s.s === 'most')).toMatchObject({ b: true })
  expect(segs.find(s => s.s === 'revisions')).toMatchObject({ i: true })
  expect(segs.find(s => s.s === 'pages.jsonl')).toMatchObject({ fg: COLORS.code })
  expect(segs.find(s => s.s === 'docs')).toMatchObject({ fg: COLORS.link, u: true })
  expect(segs.find(s => s.s === 'has')!.b).toBeFalsy()
  // the citation a blue link, not bold
  expect(segs.find(s => s.s === '13403')).toMatchObject({ fg: COLORS.link, u: true })
  const head = parseReply('## dse holds [[13403|card:abc123#revisions/dse]] revisions')[0] as Parameters<typeof paraLayout>[0]
  const hs = paraLayout(head, chips, 120, -1).lines.flat().filter(s => s.s.trim() && s.s !== '13403')
  expect(hs.length).toBeGreaterThan(0)
  expect(hs.every(s => s.b)).toBe(true)
})

test('the citation under the pointer is inverse; its tip sits on a quiet box on the row below, or above on the paragraph\'s last row', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const text = 'dse has [[13403|card:abc123#revisions/dse]] revisions, a count that runs on and on past the edge of a narrow paragraph, of [[14416|card:abc123#revisions/all]] in all.'
  const ui = (await $.ui.mount(MESSAGE(text))) as unknown as M
  await ui.resize({ columns: 40, rows: 6, in: 'para-1' })
  const block = parseReply(text)[0] as Parameters<typeof paraLayout>[0]
  const lay = paraLayout(block, [], 40, -1)
  const at = (k: number) => lay.spans.find(s => s.chip === k)!
  const tipBox = async () => {
    let found: { top?: number; bg?: unknown } | null = null
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      const o = n as { props?: Record<string, unknown>; children?: unknown }
      if (o.props?.position === 'absolute') {
        const kid = JSON.stringify(o.children ?? o.props.children)
        found = { top: o.props.top as number, bg: /"backgroundColor":"([^"]+)"/.exec(kid)?.[1] }
      }
      walk(o.children ?? o.props?.children)
    }
    walk(await ui.drawn({ in: 'para-1' }))
    return found as { top?: number; bg?: unknown } | null
  }
  const first = at(0)
  expect(first.line).toBe(0)
  await ui.pointer({ type: 'move', x: first.x0, y: first.line, in: 'para-1' } as never)
  expect(await tipBox()).toEqual({ top: 1, bg: COLORS.tip })
  // the hovered citation in inverse, in the link colour
  expect(JSON.stringify(await ui.drawn({ in: 'para-1' }))).toMatch(/"color":"remember"[^}]*"inverse":true|"inverse":true[^}]*"color":"remember"/)
  const last = at(1)
  expect(last.line).toBe(lay.lines.length - 1)
  await ui.pointer({ type: 'move', x: last.x0, y: last.line, in: 'para-1' } as never)
  expect(await tipBox()).toEqual({ top: last.line - 1, bg: COLORS.tip })
  await ui.unmount()
})
