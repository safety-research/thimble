// Citations and fix rounds: `claude plugin test mods/thimble-cc-mod`. The hooks registered here stand for the engine: a
// filesystem in memory, the resolver and subagents.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { SPIN, answerFile, applyCorrections, blockLayout, chipLook, chipSegs, chipState, claimsIn, fixItems, fixPrompt, paraLayout, parseFix, passageAt, quoteSpan, sentenceAt, sentenceIn, settleFix, streamLink, streamStep, streaming, wrapAround } from '../hooks/cite'
import type { ChipView } from '../hooks/cite'
import { lineWidth } from '../hooks/draw'
import { fixName, threadName, verifyName } from '../hooks/threads'
import { citations, parseReply } from '../hooks/lib'
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

type World = { opened: { id: string; focus?: boolean }[]; files: Map<string, string>; spawned: { prompt: string; subagentType?: string; description?: string }[]; submitted: string[]; verifyOut: string; lines?: { n: number; text: string; hit: boolean }[]; clock?: { advance: (ms: number) => Promise<void> } }

function resolveOne(ref: string, display: string | null) {
  const values: Record<string, string> = { 'card:abc123#revisions/dse': '13403', 'card:abc123#revisions/probier': '1013', 'card:abc123#revisions/all': '14416' }
  if (ref in values) {
    const v = values[ref]!
    const ok = display === null || display === v
    return { ref, kind: 'value', card: 'abc123', column: 'revisions', row: ref.split('/').at(-1), value: v, status: ok ? 'ok' : 'differs', why: ok ? `the card shows ${v}` : `the card shows ${v}, not ${display}`, window: [] }
  }
  if (ref === 'card:abc123') return { ref, kind: 'card', card: 'abc123', status: 'ok', why: 'the card exists', window: [] }
  if (ref === 'pages.jsonl#L3') return { ref, kind: 'lines', file: 'pages.jsonl', start: 3, end: 3, status: 'ok', why: 'resolves', window: [{ n: 3, text: '{"name": "Main"}', hit: true }] }
  return { ref, kind: 'file', status: 'missing', why: `no file ${ref}`, window: [] }
}

function world(on: On): World {
  const w: World = { opened: [], files: new Map([[`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)]]), spawned: [], submitted: [], verifyOut: '' }
  mock.env(on, {})
  w.clock = mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
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
    return { text: e.text } as never
  })
  on('prompt.fill', ($, e) => ({ isFilled: true, text: e.text, cursor: e.text.length }) as never)
  on('agent.spawn', ($, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description, subagentType: e.subagentType ?? (e as { subagent_type?: string }).subagent_type })
    return { model: 'm', agentId: `agent-${w.spawned.length}` }
  })
  on('ui.open', ($, e) => {
    w.opened.push({ id: e.id, focus: (e as { focus?: boolean }).focus })
    return { value: { isOpen: true } } as never
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
const MESSAGE = (text: string, requestId = 'm1') => ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble-cite', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never
const PRESS = { button: 'left', shift: false, ctrl: false, alt: false, type: 'press' }

/** A text row of main's reply, as the engine stores it (the kit stores none: its rejection is expected). */
function appendRow($: { session: { append: (args: never) => Promise<unknown> } }, uuid: string, text: string): Promise<unknown> {
  return $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
}

/** The key of a citation's claim in a row of a reply. */
function claimOf(text: string, row: string, raw: string): string {
  return claimsIn(text, row).find(cl => cl.c.raw === raw)!.key
}

// ------------------------------------------------------------------------------------------------ display

test('a citation is an underlined link; a problem is red; a spinner while it is worked on, then ✓, or ✗ and red', () => {
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
  expect(chipLook('ok', undefined, 'refuted')).toEqual({ state: 'failed', mark: '✗', spin: false })
  expect(chipLook('ok', undefined, 'running')).toEqual({ state: 'link', mark: '', spin: true })
  expect(chipLook('ok', undefined, 'asked')).toEqual({ state: 'link', mark: '', spin: true })
  expect(chipLook('ok', undefined, 'error')).toEqual({ state: 'failed', mark: '✗', spin: false })
  expect(chipLook('ok', undefined, 'missing')).toEqual({ state: 'failed', mark: '✗', spin: false })
  expect(chipLook('differs', 'fixing', undefined)).toEqual({ state: 'fixing', mark: '', spin: true })
  expect(chipLook('differs', 'failed', undefined)).toEqual({ state: 'failed', mark: '✗', spin: false })
  const link = chipSegs({ label: '412', state: 'link', mark: '', spin: false, tip: '' }, false)
  expect(link).toEqual([{ s: '412', fg: COLORS.link, u: true, inv: false }])
  expect(link[0]!.bg).toBe(undefined)
  expect(chipSegs({ label: '412', state: 'problem', mark: '', spin: false, tip: '' }, false)[0]!.fg).toBe(COLORS.problem)
  const spin = chipSegs({ label: '412', state: 'fixing', mark: '', spin: true, tip: '' }, false, 3)
  expect(spin[1]).toEqual({ s: ` ${SPIN[3]}`, fg: COLORS.problem })
  const failed = chipSegs({ label: '412', state: 'failed', mark: '✗', spin: false, tip: '' }, false)
  expect(failed).toEqual([{ s: '412', fg: COLORS.problem, u: true, inv: false }, { s: '✗', fg: COLORS.problem }])
  expect(chipSegs({ label: '412', state: 'link', mark: '✓', spin: false, tip: '' }, false)[1]).toEqual({ s: '✓', fg: COLORS.ok })
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
})

test('a reply with a failing citation goes to a forked subagent, never as a prompt to main; refused, it is marked', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await appendRow($, 'm1', REPLY)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  expect(w.submitted).toEqual([])
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.description).toBe('verification · correcting citations')
  expect(w.spawned[0]?.prompt).toContain(`1. ${BAD}`)
  expect(w.spawned[0]?.prompt).toContain('[[1014|card:abc123#revisions/probier]]: the card shows 1013, not 1014')
  // the kit starts no subagent (it drops the id a hook answers): the general-purpose fallback is refused too, and the
  // citation stays red, ✗ after it, its tip saying why
  expect(w.spawned[1]?.subagentType).toBe('general-purpose')
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const para = JSON.stringify(await ui.find({ key: 'para-3' }))
  expect(para).toContain('"state":"failed","mark":"✗"')
  expect(para).toContain('the fix failed: could not start a subagent')
  expect(para).not.toContain("couldn't fix")
  await ui.unmount()
})

test('corrections are drawn in place in the reply, unmarked, also in a later session', async ($, on) => {
  const w = world(on)
  // one made for this row, one from before corrections knew their row
  w.files.set(`${CWD}/.thimble-cc-mod/corrections.json`, JSON.stringify([{ old: BAD, new: FIXED, at: 1, row: 'm1' }, { old: 'dse has', new: 'DSE HAS', at: 1 }]))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const para = JSON.stringify(await ui.find({ key: 'para-3' }))
  expect(para).toContain('[[1013|card:abc123#revisions/probier]]')
  expect(para).not.toContain('corrected')
  expect(para).not.toContain('1014')
  expect(para).not.toContain('"state":"problem"')
  expect(JSON.stringify(await ui.find({ key: 'para-2' }))).not.toContain('DSE HAS')
  await ui.unmount()
  // a later answer that says the same keeps what it says, red
  const later = (await $.ui.mount(MESSAGE(REPLY, 'm2'))) as unknown as M
  const again = JSON.stringify(await later.find({ key: 'para-3' }))
  expect(again).toContain('[[1014|card:abc123#revisions/probier]]')
  await later.unmount()
})

test('a verification script is asked of a forked subagent, never as a prompt to main', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: dse.raw, claim: claimOf(REPLY, 'm1', dse.raw) }, ev: PRESS }] }, { in: 'para-2' })
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  expect(w.submitted).toEqual([])
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.description).toBe('verification · checking 13403')
  expect(w.spawned[0]?.prompt).toContain(`verification script of ${dse.raw}`)
  expect(w.spawned[0]?.prompt).toContain(`from the sentence "dse has ${dse.raw} of`)
  expect(w.spawned[0]?.prompt).toMatch(/Write it at \.thimble-cc-mod\/verify\/v-\w+\.py/)
  expect(await pane.find({ type: 'Text', text: /could not start a subagent/ })).toBeDefined()
  await pane.unmount()
})

test("a row of main's chat that a subagent of the mod causes is one dim line", async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const note = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "side thread · why is dse so large?" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-x', status: 'completed' } } } as never)) as unknown as M
  expect(await note.find({ type: 'Text', text: /› a thimble-cc-mod subagent · finished/ })).toBeDefined()
  await note.unmount()
  const other = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u2', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "explore" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-y', status: 'completed' } } } as never)) as unknown as M
  expect(await other.find({ type: 'Text', text: /the engine row/ })).toBeDefined()
  await other.unmount()
  const row = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'ToolUse', requestId: 'tu1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'tu1', tool: 'Agent', input: { description: 'verification · correcting citations', prompt: 'x' }, isRunning: true, isErrored: false, isInterrupted: false } } as never)) as unknown as M
  expect(await row.find({ type: 'Text', text: /› verification · correcting citations …/ })).toBeDefined()
  await row.unmount()
})

test('a verification is drawn on its citation: a spinner while it runs, ✗ and red when it recomputed another value, else ✓', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const key = claimOf(REPLY, 'm1', dse.raw)
  const script = `${CWD}/.thimble-cc-mod/verify/v-${key}.py`
  let ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: dse.raw, claim: key }, ev: PRESS }] }, { in: 'para-2' })
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  w.files.set(script, 'print("RESULT: 13400")')
  w.verifyOut = 'RESULT: 13400\n'
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await ui.find({ key: 'para-2' }))).toContain('"label":"13403","state":"failed","mark":"✗","spin":false')
  await ui.unmount()
  w.verifyOut = 'RESULT: 13403\n'
  const again = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble-cite', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  await again.press({ key: 'rerun' })
  await again.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await ui.find({ key: 'para-2' }))).toContain('"label":"13403","state":"link","mark":"✓","spin":false')
  await ui.unmount()
  // the same citation in another sentence of a later answer is not verified by this one
  const other = 'The probier wiki has [[13403|card:abc123#revisions/dse]] revisions.'
  const later = (await $.ui.mount(MESSAGE(other, 'm2'))) as unknown as M
  expect(JSON.stringify(await later.find({ key: 'para-1' }))).toContain('"label":"13403","state":"link","mark":"","spin":false')
  await later.post({ type: 'gesture', origin: 'o2', gestures: [{ seq: 1, gesture: 'menu', target: { kind: 'citation', ref: dse.raw, claim: claimOf(other, 'm2', dse.raw) }, ev: { ...PRESS, button: 'right' } }] }, { in: 'para-1' })
  await later.unmount()
  const menu = (await $.ui.mount({ ...(PANE as object), requestId: 'thimble-menu' } as never)) as unknown as M
  await menu.press({ key: 'menu-verify' })
  await menu.unmount()
  const asked = w.spawned.filter(s => s.description === 'verification · checking 13403').at(-1)!
  expect(asked.prompt).toContain(`from the sentence "${other}"`)
  expect(asked.prompt).not.toContain(script.slice(CWD.length + 1))
})

// ------------------------------------------------------------------------------------------------ verification failures

test('a verification script that crashes or is never written fails: ✗ and red, and the panel says why', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const key = claimOf(REPLY, 'm1', dse.raw)
  const script = `${CWD}/.thimble-cc-mod/verify/v-${key}.py`
  let ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: dse.raw, claim: key }, ev: PRESS }] }, { in: 'para-2' })
  await ui.unmount()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  // never written: run it, and there is no script
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^✗ not written: there is no \.thimble-cc-mod\/verify\/v-\w+\.py/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  expect(JSON.stringify(await ui.find({ key: 'para-2' }))).toContain('"label":"13403","state":"failed","mark":"✗","spin":false')
  await ui.unmount()
  // written, and it crashes (the engine's process.run answers exit 1, "no such script")
  w.files.set(script, 'import nope')
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'rerun' })
  expect(await pane.find({ type: 'Text', text: /^✗ crashed: \.thimble-cc-mod\/verify\/v-\w+\.py exited with 1 \(no such script\)/ })).toBeDefined()
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const para = JSON.stringify(await ui.find({ key: 'para-2' }))
  expect(para).toContain('"label":"13403","state":"failed","mark":"✗","spin":false')
  expect(para).toContain('script crashed')
  await ui.unmount()
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
  expect(tl.rows!.filter(r => r.includes('a1')).length).toBe(tl.lines.length - 2)
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
  expect(shown.split('\n')[0]).toBe('▍ *Which wikis have the most revisions?*')
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
  expect(await ui.find({ type: 'Text', text: /4 citations · 1 card · saved as/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /problem/ })).toBeUndefined()
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
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'record', ref: 'pages.jsonl#L3', cardId: 'ex1', text: 'x' }, ev: PRESS }] }, { in: 'para-3' })
  await ui.unmount()
  await w.clock!.advance(200) // the queued check runs
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Text', text: / · the place resolves$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /the value is/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /This citation shows no value to recompute/ })).toBeDefined()
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

test('a side thread about a citation shows it as its words, never its markup', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'thread', target: { kind: 'citation', ref: dse.raw, claim: claimOf(REPLY, 'm1', dse.raw) }, ev: { ...PRESS, shift: true } }] }, { in: 'para-2' })
  await ui.unmount()
  const pane = (await $.ui.mount({ ...(PANE as object), requestId: 'thimble-thread' } as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^13403$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\[\[/ })).toBeUndefined()
  await pane.unmount()
})

test('/thimble-ask hands the keys to its pane once the prompt is empty, so a follow-up goes to the thread', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-ask', args: 'why is dse so large?' } as never)
  await w.clock!.advance(300)
  // opened with the keys when the command ran, and asked for them again after it
  expect(w.opened.filter(o => o.id === 'thimble-thread' && o.focus).length).toBe(2)
})
