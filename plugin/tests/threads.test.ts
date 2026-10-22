// Side threads (threads/): a question typed in a pane's input bar asks the thread's fork once, even when ↵ comes twice
// before the fork started; a later question joins the running fork; its answer is read from the fork's transcript at its
// end; m sends it to main; t and the bar list the threads; a card the fork draws stands in the thread. All data is made
// up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerForks } from '../core/forks'
import { registerTell } from '../core/tell'
import { resetEngaged } from '../core/engaged'
import { askHere } from '../threads/pane'
import { threadCardAnchor, threadsBar, threadsKey } from '../threads/seam'
import { registerThreads, resetThreads, sendToMain, threadList, threadOf } from '../threads/thread'
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
