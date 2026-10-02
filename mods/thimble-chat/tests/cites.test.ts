// Citations and fix rounds: `claude plugin test mods/thimble-chat`. The hooks registered here stand for the engine: a
// filesystem in memory, the resolver and subagents.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { FAILED_MARK, SPIN, applyCorrections, chipSegs, chipState, fixItems, fixPrompt, paraLayout, parseFix, passageAt, sentenceAt, settleFix, verifyMark } from '../hooks/cite'
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
  source: { script: '.thimble-chat/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
}
const BAD = 'probier has [[1014|card:abc123#revisions/probier]], see [[pages.jsonl#L3]].'
const REPLY = ['[[card:abc123]]', '', 'dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.', '', BAD].join('\n')
const FIXED = 'probier has [[1013|card:abc123#revisions/probier]], see [[pages.jsonl#L3]].'

type World = { files: Map<string, string>; spawned: { prompt: string; subagentType?: string; description?: string }[]; submitted: string[] }

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
  const w: World = { files: new Map([[`${CWD}/.thimble-chat/cards/abc123.json`, JSON.stringify(CARD)]]), spawned: [], submitted: [] }
  mock.env(on, {})
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-chat\nguidance' }
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
      const out = req.items.map(it => ({ ...resolveOne(it.ref, it.display), id: it.id }))
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
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
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
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
const MESSAGE = (text: string) => ({ plugin: 'thimble-chat', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

// ------------------------------------------------------------------------------------------------ display

test('a citation is an underlined link; only a problem has colour, with a spinner or a static marker beside it', () => {
  expect(chipState('ok', undefined)).toBe('link')
  expect(chipState('unchecked', undefined)).toBe('link')
  expect(chipState(undefined, undefined)).toBe('link')
  expect(chipState('differs', undefined)).toBe('problem')
  expect(chipState('missing', undefined)).toBe('problem')
  expect(chipState('differs', 'fixing')).toBe('fixing')
  expect(chipState('differs', 'failed')).toBe('failed')
  expect(chipState('ok', 'failed')).toBe('link')
  const link = chipSegs({ label: '412', state: 'link', mark: '', tip: '' }, false)
  expect(link).toEqual([{ s: '412', fg: COLORS.link, u: true, inv: false }])
  expect(link[0]!.bg).toBe(undefined)
  expect(chipSegs({ label: '412', state: 'problem', mark: '', tip: '' }, false)[0]!.fg).toBe(COLORS.problem)
  const spin = chipSegs({ label: '412', state: 'fixing', mark: '', tip: '' }, false, 3)
  expect(spin[1]).toEqual({ s: ` ${SPIN[3]}`, fg: COLORS.problem })
  expect(chipSegs({ label: '412', state: 'failed', mark: '', tip: '' }, false)[1]!.s).toBe(` ${FAILED_MARK}`)
  expect(verifyMark('verified')).toBe('✓')
  expect(verifyMark('refuted')).toBe('✗')
  expect(verifyMark('running')).toBe('')
  expect(chipSegs({ label: '412', state: 'link', mark: '✓', tip: '' }, false)[1]).toEqual({ s: '✓', fg: COLORS.ok })
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
})

test('the fix answer: one line per item, CANNOT, a missing line, backticks and quotes', () => {
  const got = parseFix(['Here you go:', `\`1: ${FIXED}\``, '2. CANNOT the card has no such row', '4: stray'].join('\n'), 3)
  expect(got[0]).toEqual({ ok: true, text: FIXED })
  expect(got[1]).toEqual({ ok: false, why: 'the card has no such row' })
  expect(got[2]).toEqual({ ok: false, why: 'the fix gave no corrected text' })
  expect(parseFix('1: "quoted text"', 1)[0]).toEqual({ ok: true, text: 'quoted text' })
})

test('corrections are drawn in place and marked; a card embed stays alone on its line; $ is kept', () => {
  const out = applyCorrections(REPLY, [{ old: BAD, new: 'probier costs $1 or [[1013|card:abc123#revisions/probier]].', at: 1 }, { old: '[[card:abc123]]', new: '[[card:def456]]', at: 1 }])
  expect(out).toContain('probier costs $1 or [[1013|card:abc123#revisions/probier]]. *(corrected)*')
  expect(out.split('\n')[0]).toBe('[[card:def456]]')
  expect(applyCorrections(REPLY, [{ old: BAD, new: FIXED, at: 1 }], false)).toContain(`\n${FIXED}`)
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
})

test('a reply with a failing citation goes to a forked subagent, never as a prompt to main; refused, it is marked', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  expect(w.submitted).toEqual([])
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.description).toBe('thimble-chat fix of 1 problem')
  expect(w.spawned[0]?.prompt).toContain(`1. ${BAD}`)
  expect(w.spawned[0]?.prompt).toContain('[[1014|card:abc123#revisions/probier]]: the card shows 1013, not 1014')
  // the kit starts no subagent (it drops the id a hook answers): the general-purpose fallback is refused too, and the
  // citation stays red with the failure marker
  expect(w.spawned[1]?.subagentType).toBe('general-purpose')
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const para = JSON.stringify(await ui.find({ key: 'para-3' }))
  expect(para).toContain('"state":"failed"')
  expect(para).toContain("couldn't fix: could not start a subagent")
  await ui.unmount()
})

test('corrections are drawn in place in the reply, marked, also in a later session', async ($, on) => {
  const w = world(on)
  w.files.set(`${CWD}/.thimble-chat/corrections.json`, JSON.stringify([{ old: BAD, new: FIXED, at: 1 }]))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const para = JSON.stringify(await ui.find({ key: 'para-3' }))
  expect(para).toContain('[[1013|card:abc123#revisions/probier]]')
  expect(para).toContain('(corrected)')
  expect(para).not.toContain('1014')
  expect(para).not.toContain('"state":"problem"')
  await ui.unmount()
})

test('a verification script is asked of a forked subagent, never as a prompt to main', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const dse = citations(REPLY)[1]!
  const ui = (await $.ui.mount(MESSAGE(REPLY))) as unknown as M
  const ev = { button: 'left', shift: false, ctrl: false, alt: false, type: 'press' }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: dse.raw }, ev }] }, { in: 'para-2' })
  await ui.unmount()
  const pane = (await $.ui.mount({ plugin: 'thimble-chat', component: 'Pane', requestId: 'thimble-cite', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  await pane.press({ key: 'verify' })
  expect(w.submitted).toEqual([])
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.description).toBe('thimble-chat verification of 13403')
  expect(w.spawned[0]?.prompt).toContain(`verification script of ${dse.raw}`)
  expect(w.spawned[0]?.prompt).toMatch(/Write it at \.thimble-chat\/verify\/v-\w+\.py/)
  expect(await pane.find({ type: 'Text', text: /could not start a subagent/ })).toBeDefined()
  await pane.unmount()
})

test("a row of main's chat that a subagent of the mod causes is one dim line", async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const note = (await $.ui.mount({ plugin: 'thimble-chat', component: 'UserMessage', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "thimble-chat side thread: the card" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-x', status: 'completed' } } } as never)) as unknown as M
  expect(await note.find({ type: 'Text', text: /› thimble-chat: a subagent finished/ })).toBeDefined()
  await note.unmount()
  const other = (await $.ui.mount({ plugin: 'thimble-chat', component: 'UserMessage', requestId: 'u2', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "explore" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-y', status: 'completed' } } } as never)) as unknown as M
  expect(await other.find({ type: 'Text', text: /the engine row/ })).toBeDefined()
  await other.unmount()
  const row = (await $.ui.mount({ plugin: 'thimble-chat', component: 'ToolUse', requestId: 'tu1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'tu1', tool: 'Agent', input: { description: 'thimble-chat fix of 2 problems', prompt: 'x' }, isRunning: true, isErrored: false, isInterrupted: false } } as never)) as unknown as M
  expect(await row.find({ type: 'Text', text: /› thimble-chat fix of 2 problems …/ })).toBeDefined()
  await row.unmount()
})
