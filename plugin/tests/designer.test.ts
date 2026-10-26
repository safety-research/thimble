// v at an empty prompt and the designer fork it starts (designer/v.ts). Through the whole hooks module: v spawns the
// designer fork with designer.md once the word window has passed, and a v whose prompt cannot be made types v and says
// why. On a plain engine whose $.agent.spawn names the fork it started: its cards anchor to the answer v was pressed on,
// the busy line names it while it runs, its end says why it drew no card, and a card call with the id of main's card
// draws a card of its own. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { busySteps } from '../bar/busy'
import { failLineNow } from '../bar/notice'
import { metaOf } from '../cards/store'
import { cardCall } from '../cards/tool'
import { designAnchor, registerDesigner, vKey } from '../designer/v'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, o: { unreadable?: number } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin', TMPDIR: '/made-up/tmp' })
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  const clock = mock.clock(on, { now: 1000 })
  const spawns: Any[] = []
  let unreadable = o.unreadable ?? 0
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/designer.md') && unreadable > 0) { unreadable--; throw new Error('made-up: the file cannot be read') }
    return { value: promptStub(e.path) ?? '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-made-up', agentId: `agent-${spawns.length}` } as never })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  return { clock, spawns }
}

async function start($: Any) {
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true })
}

/** Main answers: its text row, as session.append stores it. */
async function answer($: Any) {
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The revert undid a change that broke the build.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' })
}

const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

const press = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k })

test('v at an empty prompt spawns the designer fork with designer.md once the word window has passed', async ($, on) => {
  const w = world(on)
  await start($)
  await answer($)
  const r = (await $.prompt.edit(press('v') as never)) as Any
  expect(r.text).toBe('')
  await w.clock.advance(100)
  expect(w.spawns.length).toBe(0)
  await w.clock.advance(300)
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toBe('PROMPT designer')
  expect(w.spawns[0].description).toBe('card of the last answer (v)')
})

test('a click on the bar\'s `v visualize` spawns the designer fork, as v does', async ($, on) => {
  const w = world(on)
  await start($)
  await answer($)
  const bar = await $.ui.mount(BAND)
  expect(textOf(await bar.drawn())).toContain('v visualize')
  await bar.press({ key: 'bar-v' })
  await bar.unmount()
  await w.clock.advance(400)
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].description).toBe('card of the last answer (v)')
})

test('a v whose prompt cannot be made types v, says why, and the next v works', async ($, on) => {
  const w = world(on, { unreadable: 1 })
  await start($)
  await answer($)
  const r = (await $.prompt.edit(press('v') as never)) as Any
  expect(r.text).toBe('v')
  expect(textOf(await $.ui.render(BAND))).toContain('The v key did not run')
  await w.clock.advance(1000)
  expect((await $.prompt.edit(press('v') as never) as Any).text).toBe('')
  await w.clock.advance(400)
  expect(w.spawns.length).toBe(1)
})

// ---------------------------------------------------------------- the designer fork, on a plain engine

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
