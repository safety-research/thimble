// The observer's look (observer/observer.ts): after main's turn answers, one fork of the conversation reads the answer
// with the enabled lenses' sections; a long reply in the middle of a turn is read with the answer; nothing runs while
// every feature it serves is off; a reply that cannot be read is tried once more, then said on the failure line. All
// data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { registerAnswers, resetAnswers } from '../core/answers'
import { registerTurn } from '../core/turn'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup(replies: Any[]) {
  resetAnswers()
  resetObserver()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerTurn(on, {} as never)
  registerAnswers(on, {} as never)
  registerObserver(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files = new Map<string, string>()
  const forks: string[] = []
  const ran: string[][] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-observer', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    fs: {
      read: async (p: string) => { const t = promptStub(p); if (t !== undefined) return t; if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async () => [],
      exists: async () => false,
      stat: async () => ({ kind: 'missing', size: 0 }),
    },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        return tempRun(argv) ?? (argv.includes('coverage') ? { exitCode: 0, stdout: 'Claude read 3 of 7 files.', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' })
      },
    },
    model: { fork: async (r: { prompt: string }) => { forks.push(r.prompt); return replies.shift() ?? { isAnswered: false, reason: 'empty-reply' } } },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, o?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (o?.ifVersion !== undefined && o.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    // the look's own waits pass at once; its queue is drained by the test (drainNow)
    clock: { now: async () => (now += 100), after: (ms: number, fn: () => void) => { if (ms >= 1000) setTimeout(fn, 1); return { cancel() {} } } },
  }
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  /** A step of main's turn through the observer's streaming hook. */
  const step = async (turnId: string, index: number) => {
    const g = hooks['turn.step']![0]($, { turnId, index, model: 'claude-made-up' }, async function* () { return { toolUses: [] } })
    for await (const _ of g) { /* the step's pieces */ }
  }
  return { $, call, step, forks, files, ran }
}

const settle = () => new Promise(r => setTimeout(r, 5))

async function answered(s: ReturnType<typeof setup>, o: { id: string; prompt: string; rows: string[] }) {
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await s.call('prompt.submit', { text: o.prompt, origin: { kind: 'composer' } })
  await s.call('turn.start', { text: o.prompt, turnId: o.id })
  for (const [k, text] of o.rows.entries()) {
    if (k) await s.step(o.id, k)
    await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text }] } }, async () => ({ uuid: `${o.id}-row-${k}` }))
  }
  await s.call('turn.complete', { turnId: o.id, reason: 'answer', answer: o.rows.at(-1) }, async () => ({ text: '' }))
  await settle()
  await drainNow(s.$)
  await settle()
}

const READ = { isAnswered: true, text: '{"glosses": [{"term": "p95", "body": "b"}], "heads": null, "claims": []}', usage: { input_tokens: 10, output_tokens: 5 } }

test("an answer gets one look: a fork of the conversation with the lenses' sections, the message to read, the session's reads", async () => {
  setOptions({})
  const s = setup([READ])
  await answered(s, { id: 't1', prompt: 'How many test runs failed?', rows: ['Two runs failed, both on the p95 check.'] })
  expect(s.forks.length).toBe(1)
  const p = s.forks[0]!
  expect(p).toContain('OBSERVER\nPROMPT lens-explain\n\nPROMPT lens-heads\n\nPROMPT lens-claims')
  expect(p).toContain(`TURN Read this message of Claude's, above in the session: Claude's answer at the end of turn 1, which begins "Two runs failed, both on the p95 check." (1 line). It answers the analyst's message "How many test runs failed?".`)
  expect(p).toContain('KEYS v card, s squeeze, c claims')
  expect(p).toContain('CARDS No cards in these turns.')
  expect(p).toContain('READ Claude read 3 of 7 files.')
  expect(p).toContain('REPLY {"glosses": [], "heads": null, "claims": []}')
  // the session's coverage, as the person's command of the session's own records
  expect(s.ran.some(a => a.includes('coverage'))).toBe(true)
  const log = JSON.parse(s.files.get('/made-up/.thimble/conversations/s-observer/observer.json')!).log
  expect(log.at(-1)).toMatchObject({ kind: 'look', turn: 1, fork: { lenses: { explain: 'lens-explain', heads: 'lens-heads', claims: 'lens-claims' } } })
})

test('with every feature it serves off, no look runs; one lens off has no section', async () => {
  setOptions({ explain: false, details: false, claims: false })
  const off = setup([READ])
  await answered(off, { id: 't1', prompt: 'Why?', rows: ['Because.'] })
  expect(off.forks.length).toBe(0)
  setOptions({ claims: false })
  const two = setup([READ])
  await answered(two, { id: 't1', prompt: 'Why?', rows: ['Because.'] })
  expect(two.forks[0]).not.toContain('lens-claims')
  expect(two.forks[0]).toContain('REPLY {"glosses": [], "heads": null}')
  setOptions({})
})

test("a reply that cannot be read is tried once more, then the failure line says what is missing and why", async () => {
  setOptions({})
  const s = setup([{ isAnswered: true, text: 'no json here' }, { isAnswered: true, text: 'still none' }])
  await answered(s, { id: 't1', prompt: 'Why?', rows: ['Because.'] })
  await new Promise(r => setTimeout(r, 20))
  await settle()
  expect(s.forks.length).toBe(2)
  expect((await failLineNow(s.$))?.text).toBe("thimble could not add explainers, details, claims to Claude's last answer: its reply could not be read.")
})

