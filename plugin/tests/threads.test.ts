// Side threads (threads/): a question typed in a pane's input bar asks the thread's fork once, even when ↵ comes twice
// before the fork started; a later question joins the running fork; its answer is read from the fork's transcript at its
// end; m sends it to main; t and the bar list the threads; a card the fork draws stands in the thread. All data is made
// up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerForks } from '../core/forks'
import { registerTell } from '../core/tell'
import { resetEngaged } from '../core/engaged'
import { askHere, drawThreads, passageRuns, threadUnder, threadUnderParts } from '../threads/pane'
import { keptDir } from '../core/env'
import { openThread, threadCardAnchor, threadOnCard, threadPassages, threadsBar, threadsKey } from '../threads/seam'
import { registerThreads, resetThreads, sendToMain, threadList, threadOf } from '../threads/thread'
import { threadKey } from '../threads/threads.mjs'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SCOPE = { about: '41 of the 44', mark: { row: 'row-made-up-1', kind: 'citation' as const, n: 1 } }
const KEY = 'mark-row-made-up-1-citation-1'

function setup(o: { denyFork?: boolean } = {}) {
  resetThreads()
  resetEngaged()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { (hooks[event] ??= []).push(typeof a === 'function' ? a : b); return { catch: () => undefined } }
  registerForks(on, {} as never)
  registerTell(on, {} as never)
  registerThreads(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files: Record<string, string> = {}
  const spawns: Any[] = []
  const sent: Any[] = []
  const submitted: Any[] = []
  const ended = new Set<string>()
  const transcripts = new Map<string, Any[]>()
  let release: (() => void) | null = null
  let calls = 0
  const $: Any = {
    plugin: { root: '/made-up/plugins/thimble/plugin', name: 'thimble' },
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', THIMBLE_ROOT: '/made-up/data' } as Any)[k] },
    session: {
      id: async () => 's-threads', cwd: async () => '/made-up/data',
      messages: async (a: Any) => (a?.agentId ? transcripts.get(a.agentId) ?? [] : []),
      send: async (a: Any) => {
        sent.push(a)
        transcripts.get(a.to.agentId)?.push({ role: 'user', content: [{ type: 'text', text: `The coordinator sent a message while you were working:\n${a.text}\n\nAddress this before completing your current task.` }] })
        return { isDelivered: true }
      },
    },
    fs: {
      read: async (p: string) => { if (p in files) return files[p]; const s = promptStub(p); if (s !== undefined) return s; throw new Error('none') },
      write: async (p: string, c: string) => { files[p] = c },
      list: async (dir: string) => Object.keys(files).filter(f => f.startsWith(`${dir}/`)).map(f => ({ name: f.slice(dir.length + 1), kind: 'file' })),
    },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, opt?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (opt?.ifVersion !== undefined && opt.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => Date.now(), every: () => () => undefined, after: () => ({ cancel() {} }), sleep: async () => undefined },
    ui: { invalidate: () => undefined, open: async () => ({ isPlaced: true }), close: async () => undefined, panes: async () => [] },
    command: { register: async () => ({}) },
    // a prompt of the plugin's goes through the hooks, as Claude Code sends it (origin plugin)
    prompt: { submit: async (a: Any) => { submitted.push(a); return call('prompt.submit', { ...a, origin: { kind: 'plugin', name: 'thimble' } }) } },
    agent: {
      register: async () => ({ agent: 'thimble:thread' }),
      list: async () => spawns.map((_, i) => ({ id: `agent-${i + 1}`, status: ended.has(`agent-${i + 1}`) ? 'completed' : 'running' })),
      spawn: async (a: Any) => {
        // the first spawn waits until the test lets it go, so a second ↵ comes while it starts
        if (!calls++) await new Promise<void>(r => { release = r })
        if (o.denyFork && a.subagentType === 'fork') return { deny: 'forks are off here' }
        spawns.push(a)
        const id = `agent-${spawns.length}`
        transcripts.set(id, [{ role: 'user', content: [{ type: 'text', text: a.subagentType === 'fork' ? `<fork-boilerplate>b</fork-boilerplate>\nYour directive: ${a.prompt}` : a.prompt }] }])
        return { model: 'claude-made-up', agentId: id }
      },
    },
  }
  const call = async (event: string, e: Any, next: Any = async (x: Any) => x) => {
    // every hook of the event, as if each matched; a dropped prompt goes no further
    let r: Any
    for (const h of hooks[event] ?? []) { r = await h($, e, next); if (r?.drop) return r }
    return r
  }
  const answer = (id: string, text: string) => transcripts.get(id)!.push({ role: 'assistant', content: [{ type: 'text', text }] })
  const told = async () => Object.values(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  return { $, call, files, spawns, sent, submitted, ended, answer, told, go: () => release?.() }
}

/** Elements as plain objects, for reading what the pane draws. */
const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any) => ({ type, props }) })
const nodes = (node: Any, out: Any[] = []): Any[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => nodes(n, out)); return out }
  out.push(node)
  nodes(node.props?.children, out)
  return out
}
const textOf = (node: Any): string => {
  if (node == null || node === false) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const settle = () => new Promise(r => setTimeout(r, 5))

test('a second ↵ while the fork starts asks nothing more; the answer comes from the fork\'s transcript at its end', async () => {
  const s = setup()
  expect(await threadsKey(s.$, 't', 0)).toBe(null)
  const one = askHere(s.$, SCOPE, 'why so many?')
  const two = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await Promise.all([one, two])
  expect(s.spawns.length).toBe(1)
  expect(s.spawns[0].subagentType).toBe('fork')
  expect(s.spawns[0].prompt).toContain('PROMPT thread')
  expect(s.spawns[0].prompt).toContain('why so many?\n\nAbout: Claude\'s citation "41 of the 44" in its reply.\nThe data: /made-up/data')
  expect(threadOf(KEY)!.asks.map(a => a.text)).toEqual(['why so many?'])
  expect(threadOf(KEY)!.status).toBe('running')
  // main reads the question, not the answer
  expect(await s.told()).toContain('- They asked a side thread about 41 of the 44, which a side agent answers there: "why so many?"')
  // the bar counts it, and t lists it once the word window closed
  expect((await threadsBar(s.$, () => true, false)).map(x => `${x.key} ${x.words}`)).toEqual(['t 1 thread'])
  expect(typeof (await threadsKey(s.$, 't', 0))?.later).toBe('function')
  // the fork answers and ends
  s.answer('agent-1', 'The config gives the timeout in minutes (ci.yml:12).')
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  const t = threadOf(KEY)!
  expect(t.status).toBe('done')
  expect(t.turns.map(x => [x.role, x.text])).toEqual([['person', 'why so many?'], ['claude', 'The config gives the timeout in minutes (ci.yml:12).']])
  // kept in the conversation's folder, never in the folder under analysis
  expect(Object.keys(s.files).some(f => f.startsWith('/made-up/.thimble/') && f.endsWith(`/threads/${KEY}.json`))).toBe(true)
  expect(Object.keys(s.files).some(f => f.startsWith('/made-up/data/'))).toBe(false)
  // m: the answer goes to main at once, as a prompt of its own (a turn of main's), with what else waits for main
  expect(await sendToMain(s.$, KEY)).toBe(true)
  await settle()
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0].text).toContain('The analyst sent you the answer of a side thread about 41 of the 44. They asked there: "why so many?"\nThe side agent answered:\nThe config gives the timeout in minutes (ci.yml:12).')
  // the question line went with it, so the person's next prompt carries neither again
  const r = await s.call('prompt.submit', { text: 'ok, and now?', origin: { kind: 'composer' } })
  expect(r.context ?? []).toEqual([])
  expect(threadOf(KEY)!.sent).toBe(2)
  expect(threadList().length).toBe(1)
})

test('m on the thread of a failed citation: main answers the correction now; a prompt that does not enter waits for the next one', async () => {
  const s = setup()
  const scope = { about: 'ran on 9 made-up GPUs', mark: { row: 'row-made-up-2', kind: 'citation' as const, n: 1 } }
  const key = threadKey(scope)
  const asking = askHere(s.$, scope, 'what does the manifest say? correct it')
  await settle()
  s.go()
  await asking
  s.answer('agent-1', 'The manifest names [no hardware](#). A correct sentence: "The run used 12 agents for 3 hours."')
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  expect(await sendToMain(s.$, key)).toBe(true)
  await settle()
  expect(s.submitted.map(x => x.text)).toEqual([expect.stringContaining('The manifest names no hardware. A correct sentence: "The run used 12 agents for 3 hours."')])
  // a hook refused the prompt: the answer waits for the person's next prompt instead, and a line says so
  s.$.prompt.submit = async (a: Any) => { s.submitted.push(a); return { drop: 'made-up refusal' } }
  s.answer('agent-1', 'Also: the run ended early.')
  await s.call('turn.complete', { turnId: 'f2', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  expect(await sendToMain(s.$, key)).toBe(true)
  await settle()
  const r = await s.call('prompt.submit', { text: 'and?', origin: { kind: 'composer' } })
  expect(r.context[0]).toContain('The side agent answered:\nAlso: the run ended early.')
})

test('a later question joins the running fork; once it ended, a new fork is told the earlier turns', async () => {
  const s = setup()
  const first = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await first
  await askHere(s.$, SCOPE, 'and the 3 that passed?')
  expect(s.spawns.length).toBe(1)
  expect(s.sent.map(x => [x.to.agentId, x.text])).toEqual([['agent-1', 'and the 3 that passed?']])
  s.answer('agent-1', 'They ran before the change.')
  s.ended.add('agent-1')
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  expect(threadOf(KEY)!.turns.map(x => x.text)).toEqual(['why so many?', 'and the 3 that passed?', 'They ran before the change.'])
  await askHere(s.$, SCOPE, 'which config?')
  expect(s.spawns.length).toBe(2)
  expect(s.spawns[1].prompt).toContain('Earlier in this thread:\nQ: why so many?\nQ: and the 3 that passed?\nA: They ran before the change.')
})

test('where no fork starts, the thread\'s own agent type answers; a card its agent draws stands in the thread', async () => {
  const s = setup({ denyFork: true })
  const asked = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await asked
  expect(s.spawns.map(x => x.subagentType)).toEqual(['thimble:thread'])
  // the type is offered only while a question is asked
  expect((await s.call('agent.offer', { agent: 'thimble:thread' })).isOffered).toBe(false)
  expect(await threadCardAnchor(s.$, 'agent-1', 'c00000000000a1')).toBe(`thread:${KEY}`)
  expect(threadOf(KEY)!.asks[0]!.cards).toEqual(['c00000000000a1'])
  expect(await threadCardAnchor(s.$, 'agent-9', 'c00000000000a2')).toBe(null)
  // its report never reaches main
  const dropped = await s.call('prompt.submit', { text: '<task-notification><task-id>agent-1</task-id></task-notification>', origin: { kind: 'task-notification' } })
  expect(dropped.drop).toContain('thread')
})

test('a key that cannot open a thread in a narrow terminal says to type /threads; once /threads opens it, that line goes', async () => {
  const s = setup()
  const line = async () => String(((await s.$.state.get({ plugin: 'thimble', key: 'failLine' })).value as Any)?.text ?? '')
  s.$.ui.open = async () => ({ isPlaced: false })
  expect(await openThread(s.$, SCOPE)).toBe(false)
  expect(await line()).toContain('Type /threads to open it')
  // a command's pane is placed at any width: it opens the thread on the citation's evidence
  s.$.ui.open = async () => ({ isPlaced: true })
  await s.call('command.run', { command: 'threads' }, async () => ({}))
  await settle()
  expect(await line()).toBe('')
})

test('the margin of a passage or a card opens its thread; it says asked (↳) once a question was asked there', async () => {
  const s = setup()
  const p = { text: 'Two runs failed.', label: '"Two runs failed."' }
  const margin = await threadPassages(s.$, 'row-made-up-2')
  expect(margin.has(p)).toBe(false)
  margin.ask(p)
  await settle()
  // opened to be asked, with no question yet: not listed, and the margin still asks
  expect(threadList().length).toBe(0)
  expect((await threadPassages(s.$, 'row-made-up-2')).has(p)).toBe(false)
  const scope = { about: p.label, passage: { row: 'row-made-up-2', text: p.text } }
  const asked = askHere(s.$, scope, 'which two?')
  await settle()
  s.go()
  await asked
  expect(s.spawns[0].prompt).toContain('which two?\n\nAbout: this passage of Claude\'s message:\nTwo runs failed.')
  expect((await threadPassages(s.$, 'row-made-up-2')).has(p)).toBe(true)
  expect((await threadPassages(s.$, 'row-made-up-3')).has(p)).toBe(false)
  // a card: the thread the tray's a opens on it
  const card = await threadOnCard(s.$, 'c00000000000b1', 'Runs per day')
  expect(card.label).toBe('the card "Runs per day"')
  expect(card.has).toBe(false)
  card.press()
  await settle()
  expect(threadOf('card-c00000000000b1')!.scope).toEqual({ about: 'the card "Runs per day"', card: 'c00000000000b1' })
  // a bar a click selected: the margin asks about that bar, in a thread of its own
  const bar = await threadOnCard(s.$, 'c00000000000b1', 'Runs per day', '  ▸ Tuesday  ██████ 41')
  expect(bar.label).toBe('"Tuesday 41" in the card "Runs per day"')
  expect(bar.has).toBe(false)
  bar.press()
  await settle()
  const key = threadKey({ about: '', card: 'c00000000000b1', part: '▸ Tuesday  ██ 41' })
  expect(key).not.toBe('card-c00000000000b1')
  expect(threadOf(key)!.scope).toEqual({ about: '"Tuesday 41" in the card "Runs per day"', card: 'c00000000000b1', part: '▸ Tuesday  ██████ 41' })
  // a click on a bar the view drew, with nothing selected: a thread about that bar's row, of its own
  const clicked = await threadOnCard(s.$, 'c00000000000b1', 'Runs per day', '', { text: '███', line: '  Monday   ███ 12' })
  expect(clicked.label).toBe('"Monday 12" in the card "Runs per day"')
  clicked.press()
  await settle()
  expect(threadOf(threadKey({ about: '', card: 'c00000000000b1', part: 'Monday  ███ 12' }))!.scope.part).toBe('Monday  ███ 12')
})

// Claude Code places a pane at any width only for an open made while the person's press runs: one the press leaves to
// run after it returned is unasked and waits undrawn below 144 columns. So each press that opens the side pane (the
// margin of a passage or a card, a row of the thread list) returns the open, and the open is made by the time what it
// returns settles, as Claude Code calls a press. (The way back to the list is the pane's own top row: core/pane.ts.)
test('each press that opens the side pane makes the open inside the press', async () => {
  const s = setup()
  const opens: string[] = []
  const later = <T>(v: T) => new Promise<T>(r => setTimeout(() => r(v), 1))
  s.$.ui.open = (a: Any) => later((opens.push(a.id), { isPlaced: true }))
  const pressed = async (press: () => unknown) => {
    const before = opens.length
    const r = press()
    expect(r).toBeInstanceOf(Promise)
    await r
    return opens.length - before
  }
  const p = { text: 'Two runs failed.', label: '"Two runs failed."' }
  const margin = await threadPassages(s.$, 'row-made-up-5')
  expect(await pressed(() => margin.ask(p))).toBe(1)
  const card = await threadOnCard(s.$, 'c00000000000b2', 'Runs per day')
  expect(await pressed(card.press)).toBe(1)
  // a thread the list shows, and the way back from it
  const asked = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await asked
  const list = nodes(await drawThreads(s.$, { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }, 'threads', {}, els))
  expect(await pressed(list.find(n => n.type === 'Button' && n.props?.key === 'thread-0-open').props.onPress)).toBe(1)
})

test('the list of threads (t) draws each thread as a press that holds only text, as Claude Code draws a Button', async () => {
  const s = setup()
  const asked = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await asked
  const all = nodes(await drawThreads(s.$, { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }, 'threads', {}, els))
  const presses = all.filter(n => n.type === 'Button')
  expect(presses.length).toBe(1)
  expect(textOf(presses[0])).toContain('41 of the 44')
  // a Box inside a Button makes Claude Code refuse the whole pane
  for (const b of presses) expect(nodes(b.props.children).some(n => n.type === 'Box')).toBe(false)
  expect(textOf(all.find(n => n.props?.key === 'q'))).toContain('why so many?')
})

test('the thread pane: its steps without the folders they ran in, and m drawn once as Claude Code draws a key', async () => {
  const s = setup()
  const asked = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await asked
  s.$.session.messages = async () => [
    { role: 'user', content: [{ type: 'text', text: `<fork-boilerplate>b</fork-boilerplate>\nYour directive: ${s.spawns[0].prompt}` }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /made-up/data/runs/r1 && python3 count.py' } }] },
    { role: 'user', content: [{ type: 'tool_result', content: '41' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Most stopped early (runs.jsonl).' }] },
  ]
  // the words typed in the input bar while the thread answered
  const before = nodes(await drawThreads(s.$, { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }, 'thread', { key: KEY }, els)).find(n => n.type === 'Input')
  before.props.onInput('and then')
  const focus: Any[] = []
  s.$.ui.focus = async (a: Any) => { focus.push(a); return {} }
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  const tree = await drawThreads(s.$, { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }, 'thread', { key: KEY }, els)
  const all = nodes(tree)
  // the answer's drawing brings a new field, with those words, and the focus ring is asked onto it before: m, drawn
  // above the field, does not take the ring's place (Claude Code draws a Button the ring is on inverted)
  const field = all.find(n => n.type === 'Input')
  expect(field.props.key).not.toBe(before.props.key)
  expect(field.props.value).toBe('and then')
  expect(focus).toEqual([{ requestId: 'thimble', key: field.props.key }])
  const steps = all.find(n => String(n.props?.key ?? '').endsWith('-steps'))
  expect(textOf(steps)).toBe('● 1 step · python3 count.py')
  expect(all.some(n => typeof n.props?.children === 'string' && n.props.children.includes('/made-up'))).toBe(false)
  // m in the keys' row above the input bar, dim at rest as a key's hint; the Button draws its key and label itself
  // (`m: add this answer to the main conversation`): no second key or label inside it
  const m = all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-m')
  expect(m.props.hotkey).toBe('m')
  expect(m.props.label).toBe('add this answer to the main conversation')
  expect(m.props.dimColor).toBe(true)
  expect(m.props.children).toBe(undefined)
  // under the pointer its words brighten, never Claude Code's inverse of a plain Button
  expect(m.props.hover?.inverse).toBe(false)
  const kids = tree.props.children as Any[]
  expect(kids.indexOf(all.find(n => n.props?.key === 'thread-keys'))).toBe(kids.findIndex((n: Any) => n.props?.key === 'entry-gap') - 1)
})

test("a card's thread shows the card collapsed, its title and the line asked about; e draws it whole", async () => {
  const s = setup()
  s.$.ui.resolve = () => els
  const id = 'c00000000000b3'
  await s.$.state.set({ plugin: 'thimble', key: 'card', id }, { id, version: 1, gen: 1, title: 'Merges per run', keys: [], calls: {}, at: 1 })
  const scope = { about: 'the card "Merges per run"', card: id, part: '▸ r1 made-up  2 merged  +12' }
  const opened = await openThread(s.$, scope)
  expect(opened).toBe(true)
  // the thread of the line asked about
  const draw = async () => drawThreads(s.$, { props: { bodyColumns: 60, scroll: { bodyRows: 40 } }, viewport: { columns: 60 } }, 'thread', { key: threadKey(scope) }, els)
  let all = nodes(await draw())
  expect(textOf(all.find(n => n.props?.key === 'subject-t'))).toBe('▎ Merges per run')
  const part = all.find(n => n.props?.key === 'subject-m0')
  expect(textOf(part)).toBe('▎ ▸ r1 made-up  2 merged  +12')
  expect(part.props.wrap).toBe('truncate-end')
  expect(all.some(n => n.type === 'Client')).toBe(false)
  const e = all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-e')
  expect(e.props.label).toBe('show the card')
  // e typed into the input bar, which holds the ring: a question that starts with e types as usual
  const later: Array<() => void> = []
  s.$.clock.after = ((_ms: number, f: () => void) => { later.push(f); return { cancel() {} } }) as Any
  const field = () => all.find(n => n.type === 'Input')
  field().props.onInput('e')
  field().props.onInput('ex')
  later.splice(0).forEach(f => f())
  all = nodes(await draw())
  expect(all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-e').props.label).toBe('show the card')
  field().props.onInput('')
  // e alone presses the key, as a click does, and the field starts empty again
  const before = field().props.key
  field().props.onInput('e')
  later.splice(0).forEach(f => f())
  all = nodes(await draw())
  expect(all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-e').props.label).toBe('hide the card')
  expect(field().props.key).not.toBe(before)
  // whole: the conversation's drawing (as wide as main's), cut at the pane's edge, so no row of it wraps
  const cut = all.find(n => n.props?.key === 'cut')
  const client = all.find(n => n.type === 'Client')
  expect(cut.props.overflow).toBe('hidden')
  expect(cut.props.width).toBe(54)
  expect(client.props.width).toBeGreaterThan(54)
})

test("a passage's thread shows the passage as the reply reads, under one label: no citation markup, no quoted title", async () => {
  const s = setup()
  const text = 'Saves peaked on [June 18, with 6,543 saves under 906 names](#).\n\n- **Links** came [after noon](#).'
  const scope = { about: '"Saves peaked on June 18…"', passage: { row: 'row-made-up-4', text } }
  const asked = askHere(s.$, scope, 'why then?')
  await settle()
  s.go()
  await asked
  const tree = await drawThreads(s.$, { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }, 'thread', { key: threadKey(scope) }, els)
  const subject = nodes(tree).find(n => n.props?.key === 'subject')
  const shown = textOf(subject)
  expect(shown).toContain("A passage of Claude's reply")
  expect(shown).toContain('Saves peaked on June 18, with 6,543 saves under 906 names. Links came after noon.')
  expect(shown).not.toContain('](#)')
  expect(shown).not.toContain('**')
  expect(shown).not.toContain(scope.about)
  // each cited words underlined as in the reply
  expect(nodes(subject).filter(n => n.props?.underline).map(textOf)).toEqual(['June 18, with 6,543 saves under 906 names', 'after noon'])
  expect(passageRuns('a [b](#) c', 4).map(r => r.s).join('')).toBe('a b…')
})

test("a heads-up's thread shows it as the tray does: named a heads-up, its links as words, each point's rows after the gutter", async () => {
  const s = setup()
  const mark = { row: 'row-made-up-5', kind: 'heads' as const, id: 'h1' }
  await s.$.state.set({ plugin: 'thimble', key: 'answerMsg', id: mark.row }, { row: mark.row, turnId: 't5', text: 'Retries rose.', at: 1, parts: { explain: { order: ['h1'], items: { h1: {
    id: 'h1', kind: 'heads', term: 'Retries rose', title: 'Retried runs count twice',
    bullets: ['A run that was retried has two rows in [runs.csv](runs.csv#L4-9), so the count of failed runs is too high by about a third.'],
  } } } } })
  const scope = { about: 'the heads-up "Retried runs count twice"', mark }
  const asked = askHere(s.$, scope, 'how many retried?')
  await settle()
  s.go()
  await asked
  const tree = await drawThreads(s.$, { props: { bodyColumns: 50, scroll: { bodyRows: 40 } } }, 'thread', { key: threadKey(scope) }, els)
  const subject = nodes(tree).find(n => n.props?.key === 'subject')
  const shown = textOf(subject)
  expect(shown).toContain('▎ heads-up')
  expect(shown).not.toContain('important detail')
  expect(shown).toContain('two rows in runs.csv, so')
  expect(shown).not.toContain('](')
  // the point wraps in a column of its own after the gutter, so its later rows stay under its first
  const point = subject.props.children.find((n: Any) => n.props?.key === 'subject-m0')
  expect(point.type).toBe('Box')
  expect(point.props.flexDirection).toBe('row')
  expect(textOf(point.props.children[0])).toBe('▎ ')
})

// The pane reads a running thread's turns every few seconds. A read that started before the fork ended, and ends after
// the end marked the thread done, leaves it done: else the pane shows it answering for ever, without m
test("a read of a running thread's turns that the fork's end overtakes leaves the thread done", async () => {
  const s = setup()
  let poll: (() => void) | null = null
  s.$.clock.every = (_ms: number, f: () => void) => { poll = f; return () => undefined }
  const asked = askHere(s.$, SCOPE, 'why so many?')
  await settle()
  s.go()
  await asked
  expect(threadOf(KEY)!.status).toBe('running')
  expect(poll).not.toBe(null)
  s.answer('agent-1', 'The config gives the timeout in minutes (ci.yml:12).')
  // the poll's read waits; the fork's end reads at once
  const read = s.$.session.messages
  let release: (() => void) | null = null
  s.$.session.messages = async (a: Any) => { s.$.session.messages = read; await new Promise<void>(r => { release = r }); return read(a) }
  poll!()
  await settle()
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  expect(threadOf(KEY)!.status).toBe('done')
  release!()
  await settle()
  expect(threadOf(KEY)!.status).toBe('done')
})

test('under the claims pane the input names what it asks about, each question shows its claim quoted above it, and m says the answer went to the main conversation', async () => {
  const s = setup()
  const store = { v: 2, session: 's-threads', updated: null, gaps: [],
    claims: [{ id: 'c1', text: 'Run 4 failed on the p95 check.', by: 'claude', cluster: 'k1', turn: 1, said: [{ row: 'r1', by: 'claude', turn: 1, quote: 'Run 4 failed', sentence: 'Run 4 failed on the p95 check.' }], sources: [] }],
    clusters: [{ id: 'k1', name: 'failures', turn: 1, named: 1 }] }
  s.files[`${await keptDir(s.$)}/claims.json`] = JSON.stringify(store)
  const e = { props: { bodyColumns: 80, scroll: { bodyRows: 40 } } }
  const input = async (args: Any) => nodes(await threadUnder(s.$, e, 'claims', args, els)).find(n => n.type === 'Input')
  expect((await input({ claim: 'c1' })).props.placeholder).toBe('Ask about: “Run 4 failed on the p95 check.”')
  expect((await input({ group: 'k1' })).props.placeholder).toBe('Ask about the whole cluster “failures”…')
  expect((await input({})).props.placeholder).toBe('Ask about all the claims…')
  // no conversation yet: nothing scrolls with the pane's drawing, so the pane opens at its top (core/pane.ts); the
  // blank row under the drawing stands with the input bar
  const bare = await threadUnderParts(s.$, e, 'claims', { claim: 'c1' }, els)
  expect(bare.conv).toEqual([])
  expect(bare.bottom[0].props.key).toBe('thread-gap')
  // a question about the claim: the claim quoted above it once answered, in place of `about this claim`
  const scope = { about: 'the claim', pane: { kind: 'claims', args: { claim: 'c1' } } }
  const asked = askHere(s.$, scope as Any, 'why the p95?')
  await settle()
  s.go()
  await asked
  s.answer('agent-1', 'The p95 check failed because two requests timed out.')
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  const parts = await threadUnderParts(s.$, e, 'claims', { claim: 'c1' }, els)
  expect(parts.conv[0].props.key).toBe('thread-gap')
  expect(parts.bottom.some((n: Any) => n.props?.key === 'thread-gap')).toBe(false)
  const under = nodes(await threadUnder(s.$, e, 'claims', { claim: 'c1' }, els))
  const t = textOf({ props: { children: under } })
  expect(t).toContain('▎ “Run 4 failed on the p95 check.”❯ why the p95?')
  expect(t).not.toContain('about this claim')
  const m = under.find(n => n.type === 'Button' && n.props?.key === 'thread-key-m')
  expect(m.props.label).toBe('add this answer to the main conversation')
  const key = threadList()[0]!.key
  expect(await sendToMain(s.$, key)).toBe(true)
  const after = nodes(await threadUnder(s.$, e, 'claims', { claim: 'c1' }, els))
  expect(textOf({ props: { children: after } })).toContain('✓ added to the main conversation: Claude reads it there and replies to it')
  expect(after.find(n => n.type === 'Button' && n.props?.key === 'thread-key-m').props.label).toBe('added to the main conversation')
})
