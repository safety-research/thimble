// The designer fork's life (designer/v.ts), on a plain engine whose $.agent.spawn names the fork it started: its cards
// anchor to the answer v was pressed on, the busy line names it while it runs, and its end says why it drew no card.
// All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { busySteps } from '../bar/busy'
import { failLineNow, failNotice } from '../bar/notice'
import { metaOf, saveMeta } from '../cards/store'
import { cardCall } from '../cards/tool'
import { designAnchor, registerDesigner, vKey } from '../designer/v'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ROW = 'row-answer-1'
// each look at the clock, in any test, is a second later: no word window is open at the next look
let now = 0

/** The module's hooks by event, and an engine that keeps state and spawns in memory. */
function setup() {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    hooks[event] = typeof a === 'function' ? a : b
    return { catch: () => undefined }
  }
  registerDesigner(on, {} as never)
  const state = new Map<string, unknown>()
  const spawns: Any[] = []
  const $: Any = {
    plugin: { root: '/made-up/plugins/thimble/plugin', name: 'thimble' },
    env: { get: async (k: string) => (k === 'TMPDIR' ? '/made-up/tmp' : undefined) },
    fs: { read: async (p: string) => promptStub(p) ?? '' },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    clock: { now: async () => (now += 1000), sleep: async () => undefined, after: () => ({ cancel() {} }) },
    agent: { spawn: async (a: Any) => { spawns.push(a); return { model: 'claude-made-up', agentId: `agent-${spawns.length}` } } },
    session: { id: async () => 's-made-up' },
    process: { run: async (argv: string[]) => tempRun(argv) ?? { exitCode: 0, stdout: '', stderr: '' } },
    // the card runner: a drawing, and its text copy
    http: {
      fetch: async (url: string) => ({
        text: JSON.stringify(url.endsWith('/load')
          ? { ok: true, tree: { t: 'Text', p: {}, c: ['x'] }, state: 'null', keys: '', lines: ['Who ran the failing test'], cut: [], summary: { rows: 9, read: '9 rows', columns: [], first: '' } }
          : { ok: true, lines: ['Who ran the failing test', '✕ ✕ ● ✕'] }),
      }),
    },
    // what the card tool asks beside the runner: the person's rules, the data file, the screen
    tool: { check: async () => ({ decision: 'allow' }) },
    ui: { invalidate: () => undefined, toast: async () => undefined },
  }
  const files = new Map<string, string>()
  $.fs.write = async (p: string, text: string) => { files.set(p, text) }
  $.fs.read = async (p: string) => files.get(p) ?? promptStub(p) ?? ''
  $.fs.stat = async (p: string) => (p.endsWith('.json') ? { kind: 'file', size: 64, realPath: p } : { kind: 'dir', size: 0, realPath: p })
  $.session.cwd = async () => '/made-up/data'
  $.session.root = async () => '/made-up/data'
  const pass = async (e: Any) => e
  const call = (event: string, e: Any, next: Any = pass) => hooks[event]($, e, next)
  const failLine = async () => String((await failLineNow($))?.text ?? '')
  return { $, call, failLine, spawns, files }
}

const settle = () => new Promise(r => setTimeout(r, 5))

/** Main answers, then the person presses v (hooks/keys.ts runs what vKey gives): the design runs. */
async function pressV(s: ReturnType<typeof setup>) {
  await s.call('session.append', { door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, message: { content: [{ type: 'text', text: 'The revert undid a change.' }] } }, async () => ({ uuid: ROW }))
  await settle()
  const take = await vKey(s.$, 'v', 0)
  expect(take).not.toBe(null)
  await take!.now()
  await settle()
  expect(s.spawns.length).toBe(1)
}

/** A card the card tool drew for an agent, as cards/tool.ts keeps it. */
const card = (id: string, agentId: string) => ({ id, version: 2, title: 'Runs of the failing test', toolUseId: `tu-${id}`, agentId, anchorRow: ROW, keys: [], rows: 9, columns: [], file: 'runs.json', gen: 2, error: null, calls: {}, at: 1 })

const end = (reason: string, answer = '', more: Any = {}) => ({ turnId: 't-1', agentId: 'agent-1', reason, answer, durationMs: 5, isAborted: reason === 'aborted', ...more })

test("the fork's cards anchor to the answer v was pressed on, and a fork that drew none says why", async () => {
  const s = setup()
  await pressV(s)
  expect(s.spawns[0].prompt).toBe('PROMPT designer')
  expect(await designAnchor(s.$, 'agent-1')).toBe(ROW)
  expect(await designAnchor(s.$, 'agent-2')).toBe(null)
  expect(busySteps()).toContain('drawing a card')
  // a later answer does not move the design's anchor
  await s.call('session.append', { door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, message: { content: [{ type: 'text', text: 'A later answer.' }] } }, async () => ({ uuid: 'row-answer-2' }))
  expect(await designAnchor(s.$, 'agent-1')).toBe(ROW)
  await s.call('turn.complete', end('answer', 'The records hold no times to draw.\nMore words.'), async () => ({ text: '' }))
  expect(await s.failLine()).toContain('v drew no card. The copy that drew it ended with: “The records hold no times to draw.”')
  expect(await designAnchor(s.$, 'agent-1')).toBe(null)
})

test("a refused design says that the model's safeguards refused it, and how to switch models, as a notice, not a failure", async () => {
  const s = setup()
  await pressV(s)
  await s.call('turn.complete', end('refusal', '', { refusal: { category: null, explanation: null } }), async () => ({ text: '' }))
  expect(await s.failLine()).toContain("The model's safeguards refused to draw this card. Another model may draw it: /model.")
  expect((await failLineNow(s.$))?.kind).toBe('notice')
  expect(await designAnchor(s.$, 'agent-1')).toBe(null)
})

test('a fork that drew a card ends done, and main reads the card with the next prompt', async () => {
  const s = setup()
  await pressV(s)
  await saveMeta(s.$, card('c0000000000001', 'agent-1') as never)
  // the line an earlier v left goes once this one draws
  failNotice(s.$, '× v drew no card.', 'v')
  await settle()
  await s.call('turn.complete', end('answer', 'Runs of the failing test: a timeline.'), async () => ({ text: '' }))
  expect(await s.failLine()).toBe('')
  const told = Object.values(((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain('a copy of you drew a card under it')
  // the card's text, fenced as the records' own words
  expect(told).toContain('“Runs of the failing test” (id "c0000000000001"), as drawn now:\n```text\nWho ran the failing test\n✕ ✕ ● ✕\n```')
})

test("the fork's card call with the id of main's card draws a new card of its own under the answer; main's card stays", async () => {
  const s = setup()
  await pressV(s)
  const view = 'function view(p, s) { return s.elements.Text({ children: "x" }) }'
  const main = await cardCall(s.$, { tool_use_id: 'toolu_made_up_main', title: 'Runs of the failing test', data: 'runs.json', view })
  const id = /Its id is "(c[0-9a-f]+)"/.exec(main.result)![1]
  // the fork read main's call in its copy of the conversation, and calls card with that id
  const v = await cardCall(s.$, { tool_use_id: 'toolu_made_up_v', agentId: 'agent-1', id, edits: [{ old: '"x"', new: '"v"' }] })
  expect(v.result).toContain(`Card "${id}" is the main conversation's card, so this call did not change it: it drew a new card of your own from that card's view and rows.`)
  expect(v.result).toContain('“Runs of the failing test” is drawn under the answer v was pressed on')
  const own = /Its id is "(c[0-9a-f]+)"/.exec(v.result)![1]
  expect(own).not.toBe(id)
  expect([...s.files].find(([p]) => p.endsWith(`/${own}/v1/view.js`))?.[1]).toBe(view.replace('"x"', '"v"'))
  // main's card is as it was, at main's call
  expect(await metaOf(s.$, id)).toMatchObject({ version: 1, agentId: null, anchorRow: null })
  expect(await metaOf(s.$, own)).toMatchObject({ version: 1, agentId: 'agent-1', anchorRow: ROW })
  // the fork's end: main reads the card it drew, and no line says it drew none
  await s.call('turn.complete', end('answer', 'I redrew the card.'), async () => ({ text: '' }))
  expect(await s.failLine()).toBe('')
  const told = Object.values(((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain(`(id "${own}")`)
})
