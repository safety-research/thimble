// Side threads (threads/): a question typed in a pane's input bar asks the thread's fork once, even when ↵ comes twice
// before the fork started; its answer is read from the fork's transcript at its end, and m sends it to main; while the
// fork works, the thread shows its question and the steps the fork took. While the tour waits for its ask step, the
// thread's answer is that step done. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { registerForks } from '../core/forks'
import { registerPanes } from '../core/pane'
import { registerTell } from '../core/tell'
import { resetEngaged } from '../core/engaged'
import { askHere, drawThreads } from '../threads/pane'
import { threadsBar, threadsKey } from '../threads/seam'
import { registerThreads, resetThreads, sendToMain, threadList, threadOf } from '../threads/thread'
import { threadKey } from '../threads/threads.mjs'
import { treeRows } from '../core/trail.mjs'
import { noteViewport } from '../cards/draw'
import { setOptions } from '../settings/features.mjs'
import { tourDid, tourNow, tourStart } from '../tour/tour'
import { promptStub } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SCOPE = { about: '41 of the 44', mark: { row: 'row-made-up-1', kind: 'citation' as const, n: 1 } }
const KEY = 'mark-row-made-up-1-citation-1'

function setup() {
  resetThreads()
  resetEngaged()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { (hooks[event] ??= []).push(typeof a === 'function' ? a : b); return { catch: () => undefined } }
  registerForks(on, {} as never)
  registerTell(on, {} as never)
  registerPanes(on, {} as never)
  registerThreads(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files: Record<string, string> = {}
  const spawns: Any[] = []
  const submitted: Any[] = []
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
      list: async () => spawns.map((_, i) => ({ id: `agent-${i + 1}`, status: 'running' })),
      spawn: async (a: Any) => {
        // the first spawn waits until the test lets it go, so a second ↵ comes while it starts
        if (!calls++) await new Promise<void>(r => { release = r })
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
  return { $, call, files, spawns, submitted, answer, told, go: () => release?.() }
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

test("a running thread under a tall heads-up shows its question and the steps its fork took; the pane counts the heads-up's rows at the width they wrap at", async () => {
  const s = setup()
  let poll: (() => void) | null = null
  s.$.clock.every = (_ms: number, f: () => void) => { poll = f; return () => undefined }
  const mark = { row: 'row-made-up-6', kind: 'heads' as const, id: 'h1' }
  const point = 'A run that was retried has two rows in runs.csv, so the count of failed runs is too high by about a third, and the median time is off as well.'
  await s.$.state.set({ plugin: 'thimble', key: 'answerMsg', id: mark.row }, { row: mark.row, turnId: 't6', text: 'Retries rose.', at: 1, parts: { explain: { order: ['h1'], items: { h1: {
    id: 'h1', kind: 'heads', term: 'Retries rose', title: 'Retried runs count twice', bullets: [point, point, point],
  } } } } })
  const scope = { about: 'the heads-up "Retried runs count twice"', mark }
  const asked = askHere(s.$, scope, 'how many were retried?')
  await settle()
  s.go()
  await asked
  // the fork wrote words, then ran a command, and works on
  s.$.session.messages = async () => [
    { role: 'user', content: [{ type: 'text', text: `<fork-boilerplate>b</fork-boilerplate>\nYour directive: ${s.spawns[0].prompt}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look at the folder of runs first.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls runs' } }] },
  ]
  poll!()
  await settle()
  expect(threadOf(threadKey(scope))!.status).toBe('running')
  const tree = await drawThreads(s.$, { props: { bodyColumns: 50, scroll: { bodyRows: 20 } } }, 'thread', { key: threadKey(scope) }, els)
  const shown = textOf(tree)
  expect(shown).toContain('how many were retried?')
  expect(shown).not.toContain('earlier turn')
  // the fork works on: its steps row turns with the bar's glyph
  expect(shown).toContain('⠋ 2 steps · ls runs')
  // each point wraps after its gutter, so the pane, which scrolls to the conversation's end, counts it at that width
  const part = nodes(tree).find(n => n.props?.key === 'subject-m0')
  expect(treeRows(part, 50)).toBe(treeRows(els.Text({ wrap: 'wrap', children: `· ${point}` }), 48))
})

test('the tour (tour/tour.ts): while its ask step waits, which holds main\'s answers, the thread\'s fork still answers, and its answer is that step done', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const s = setup()
  const card = { about: 'the card "Orders by region"', card: 'card-made-up-1' }
  await tourStart(s.$)
  for (const step of ['answer', 'e', 'v'] as const) await tourDid(s.$, step)
  expect((await tourNow(s.$))?.at).toBe('ask')
  const asked = askHere(s.$, card, 'which region refunds most?')
  await settle()
  s.go()
  await asked
  // the question alone is not the step
  expect((await tourNow(s.$))?.at).toBe('ask')
  s.answer('agent-1', 'The North refunds most.')
  await s.call('turn.complete', { turnId: 'f1', agentId: 'agent-1', reason: 'answer', answer: '', isAborted: false }, async () => ({ text: '' }))
  expect(threadOf(threadKey(card))!.turns.at(-1)).toMatchObject({ role: 'claude', text: 'The North refunds most.' })
  expect((await tourNow(s.$))?.done).toContain('ask')
  expect((await tourNow(s.$))?.at).toBe('s')
})
