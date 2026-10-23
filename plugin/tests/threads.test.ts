// Side threads (threads/): a question typed in a pane's input bar asks the thread's fork once, even when ↵ comes twice
// before the fork started; a later question joins the running fork; its answer is read from the fork's transcript at its
// end; m sends it to main; t and the bar list the threads; a card the fork draws stands in the thread. All data is made
// up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerForks } from '../core/forks'
import { registerTell } from '../core/tell'
import { resetEngaged } from '../core/engaged'
import { askHere, drawThreads, passageRuns } from '../threads/pane'
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
  return { $, call, files, spawns, sent, ended, answer, told, go: () => release?.() }
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
  // m: the answer goes to main with the next prompt
  expect(await sendToMain(s.$, KEY)).toBe(true)
  const r = await s.call('prompt.submit', { text: 'ok, and now?', origin: { kind: 'composer' } })
  expect(r.context[0]).toContain('The analyst sent you the answer of a side thread about 41 of the 44. They asked there: "why so many?"\nThe side agent answered:\nThe config gives the timeout in minutes (ci.yml:12).')
  expect(threadList().length).toBe(1)
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
  // (`m: send this answer to Claude`): no second key or label inside it
  const m = all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-m')
  expect(m.props.hotkey).toBe('m')
  expect(m.props.label).toBe('send this answer to Claude')
  expect(m.props.dimColor).toBe(true)
  expect(m.props.children).toBe(undefined)
  const kids = tree.props.children as Any[]
  expect(kids.indexOf(all.find(n => n.props?.key === 'thread-keys'))).toBe(kids.findIndex((n: Any) => n.props?.key === 'entry-gap') - 1)
})

test("a card's thread shows the card collapsed, its title and the line asked about; e draws it whole", async () => {
  const s = setup()
  s.$.ui.resolve = () => els
  const id = 'c00000000000b3'
  await s.$.state.set({ plugin: 'thimble', key: 'card', id }, { id, version: 1, gen: 1, title: 'Merges per run', keys: [], calls: {}, at: 1 })
  const opened = await openThread(s.$, { about: 'the card "Merges per run"', card: id, part: '▸ r1 made-up  2 merged  +12' })
  expect(opened).toBe(true)
  const draw = async () => drawThreads(s.$, { props: { bodyColumns: 60, scroll: { bodyRows: 40 } }, viewport: { columns: 60 } }, 'thread', { key: `card-${id}` }, els)
  let all = nodes(await draw())
  expect(textOf(all.find(n => n.props?.key === 'subject-t'))).toBe('▎ Merges per run')
  const part = all.find(n => n.props?.key === 'subject-m0')
  expect(textOf(part)).toBe('▎ ▸ r1 made-up  2 merged  +12')
  expect(part.props.wrap).toBe('truncate-end')
  expect(all.some(n => n.type === 'Client')).toBe(false)
  const e = all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-e')
  expect(e.props.label).toBe('show the card')
  e.props.onPress()
  all = nodes(await draw())
  expect(all.find(n => n.type === 'Button' && n.props?.key === 'thread-key-e').props.label).toBe('hide the card')
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
