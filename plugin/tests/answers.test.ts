// The record of main's turns (core/answers.ts): each turn's prompt and who sent it, its text rows, its answer, the
// labels its Bash calls ran and the cards it drew, each feature's part of a message, the answer the keys act on ({ }),
// and a resumed session's turns read back. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { actingRow, answerRows, answerStepKey, labelsOf, partOf, pickedRow, questionOf, registerAnswers, resetAnswers, restoreAnswers, setPart, sinceLast, textRows, turnOf, turnOfRow, turnsNow } from '../core/answers'
import { registerTurn } from '../core/turn'
import { tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The modules' hooks by event, outer first, and an engine that keeps versioned state and files in memory. */
function setup(files = new Map<string, string>()) {
  resetAnswers()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerTurn(on, {} as never)
  registerAnswers(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const scrolled: Any[] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-answers', cwd: async () => '/made-up/data', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })),
      exists: async (p: string) => files.has(p),
    },
    process: { run: async (argv: string[]) => tempRun(argv) ?? { exitCode: 0, stdout: '', stderr: '' } },
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
    clock: { now: async () => (now += 100), after: () => ({ cancel() {} }) },
    ui: { scroll: async (a: Any) => { scrolled.push(a) } },
  }
  /** One event through every module's hook, outer first, down to `last` (the engine's own answer). */
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  return { $, call, files, scrolled }
}

const settle = () => new Promise(r => setTimeout(r, 5))

/** One turn of main's: its prompt (who sent it), its rows and calls, and how it ended. */
async function turn(s: ReturnType<typeof setup>, o: { id: string; prompt: string; by?: string; rows: string[]; bash?: string[]; cards?: string[]; reason?: string }) {
  await s.call('prompt.submit', { text: o.prompt, origin: { kind: o.by ?? 'composer' } })
  await s.call('turn.start', { text: o.prompt, turnId: o.id })
  await s.call('session.append', { door: 'prompt', message: { type: 'user', content: [{ type: 'text', text: o.prompt }] } }, async () => ({ uuid: `prompt-${o.id}` }))
  let k = 0
  for (const text of o.rows) {
    const cmd = o.bash?.[k]
    if (cmd) await s.call('tool.call', { tool: 'Bash', tool_use_id: `bash-${o.id}-${k}`, command: cmd }, async () => ({ result: {}, text: 'ok' }))
    const card = o.cards?.[k]
    if (card) {
      await s.$.state.set({ plugin: 'thimble', key: 'cardCall', id: `card-${o.id}-${k}` }, { id: card })
      await s.call('tool.call', { tool: 'mcp__thimble__card', tool_use_id: `card-${o.id}-${k}` }, async () => ({ result: 'drawn', text: 'drawn' }))
    }
    await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text }] } }, async () => ({ uuid: `${o.id}-row-${k++}` }))
  }
  await s.call('turn.complete', { turnId: o.id, reason: o.reason ?? 'answer', answer: o.rows.at(-1) ?? '' }, async () => ({ text: '' }))
  await settle()
}

test("a turn keeps its prompt and who sent it, its text rows, its answer, and the labels and cards of its calls in order", async () => {
  const s = setup()
  await turn(s, { id: 't1', prompt: 'How many test runs failed?', rows: ['First I count the runs.', 'Two runs failed.'], bash: ['thimble label failed --regex "FAIL" && thimble label failed --csv'], cards: [undefined as never, 'c0000000000001'] })
  const t = await turnOf(s.$, 't1')
  expect(t).toMatchObject({ n: 1, prompt: { text: 'How many test runs failed?', by: 'composer', row: 'prompt-t1' }, rows: ['t1-row-0', 't1-row-1'], answer: 't1-row-1', reason: 'answer' })
  expect(t!.labels.map(l => [l.name, l.seq, l.ok])).toEqual([['failed', 1, true], ['failed', 1, true]])
  expect(t!.cards).toEqual([{ id: 'c0000000000001', toolUseId: 'card-t1-1', seq: 2 }])
  // the labels a card's call came after, each once
  expect((await labelsOf(s.$, 't1', 2)).map(l => l.name)).toEqual(['failed'])
  expect(await labelsOf(s.$, 't1', 1)).toEqual([])
  expect((await turnOfRow(s.$, 't1-row-0'))?.turnId).toBe('t1')
  expect(await questionOf(s.$, 't1-row-1')).toBe('How many test runs failed?')
  // a fork's rows and calls are not main's
  await s.call('session.append', { door: 'response', agentId: 'a-fork', message: { type: 'assistant', content: [{ type: 'text', text: 'checked' }] } }, async () => ({ uuid: 'fork-row' }))
  expect(await textRows(s.$)).toEqual(['t1-row-0', 't1-row-1'])
})

test('a turn that ended in an error answered nothing; the keys act on the newest answer, and { } pick another', async () => {
  const s = setup()
  await turn(s, { id: 't1', prompt: 'Why was pr/118 reverted?', rows: ['It broke the build.'] })
  await turn(s, { id: 't2', prompt: 'And pr/119?', rows: ['API Error'], reason: 'error' })
  await turn(s, { id: 't3', prompt: '<task-notification>done</task-notification>', by: 'task-notification', rows: ['The background job ended.'] })
  expect(await answerRows(s.$)).toEqual(['t1-row-0', 't3-row-0'])
  expect(await actingRow(s.$)).toBe('t3-row-0')
  // since the person's last prompt: the rows of both later turns, and the one answer among them
  expect(await sinceLast(s.$)).toEqual({ prompt: { row: 'prompt-t2', text: 'And pr/119?' }, rows: ['t2-row-0', 't3-row-0'], replies: ['t3-row-0'] })

  const back = await answerStepKey(s.$, '{')
  expect(back).not.toBe(null)
  await back!.now!()
  expect(await actingRow(s.$)).toBe('t1-row-0')
  expect(await pickedRow(s.$)).toBe('t1-row-0')
  expect(s.scrolled.at(-1)).toMatchObject({ to: { key: 'ans-t1-row-0' } })
  // past the oldest answer nothing moves; } back to the newest gives the keys back to the latest turn
  await (await answerStepKey(s.$, '{'))!.now!()
  expect(await actingRow(s.$)).toBe('t1-row-0')
  await (await answerStepKey(s.$, '}'))!.now!()
  expect(await pickedRow(s.$)).toBe(null)
  // a letter typed at once after { undoes it (hooks/keys.ts); a new turn of main's gives the keys back
  const k = await answerStepKey(s.$, '{')
  await k!.now!()
  await k!.undo!()
  expect(await pickedRow(s.$)).toBe(null)
  await (await answerStepKey(s.$, '{'))!.now!()
  await turn(s, { id: 't4', prompt: 'Thanks', rows: ['You are welcome.'] })
  expect(await actingRow(s.$)).toBe('t4-row-0')
  expect(await answerStepKey(s.$, 'x')).toBe(null)
})

test("a typed prompt is the person's though its turn starts while its prompt.submit hooks run, or before they run", async () => {
  const s = setup()
  await turn(s, { id: 't1', prompt: 'Why was pr/118 reverted?', rows: ['It broke the build.'] })
  await turn(s, { id: 't2', prompt: '<task-notification>one</task-notification>', by: 'task-notification', rows: ['The first job ended.'] })
  // Claude Code starts the turn beneath this module's prompt.submit hook
  const typed = 'Break down the events by type'
  await s.call('prompt.submit', { text: typed, origin: { kind: 'composer' } }, async (x: Any) => {
    await s.call('turn.start', { text: x.text, turnId: 't3' })
    return { text: x.text }
  })
  await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text: 'Mostly reviews.' }] } }, async () => ({ uuid: 't3-row-0' }))
  await s.call('turn.complete', { turnId: 't3', reason: 'answer', answer: 'Mostly reviews.' }, async () => ({ text: '' }))
  await settle()
  await turn(s, { id: 't4', prompt: '<task-notification>two</task-notification>', by: 'task-notification', rows: ['The second job ended.'] })
  expect((await turnOf(s.$, 't3'))!.prompt.by).toBe('composer')
  // since the person's last prompt: that prompt's turn and the one after, not the replies to the prompt before
  expect((await sinceLast(s.$)).rows).toEqual(['t3-row-0', 't4-row-0'])
  // the turn starts before the prompt's hook runs at all
  await s.call('turn.start', { text: 'And by agent?', turnId: 't5' })
  await s.call('prompt.submit', { text: 'And by agent?', origin: { kind: 'composer' } })
  expect((await turnOf(s.$, 't5'))!.prompt.by).toBe('composer')
})

test("each feature keeps its own part of a message, and a resumed session reads the turns and their parts back", async () => {
  const s = setup()
  await turn(s, { id: 't1', prompt: 'Why?', rows: ['Because the cache key ignored the locale.'] })
  await turn(s, { id: 't2', prompt: 'And?', rows: ['The retry passed.'] })
  expect(await setPart(s.$, 't1-row-0', 'squeeze', { at: { length: -1 } })).toBe(true)
  await setPart<{ terms: string[] }>(s.$, 't1-row-0', 'explain', cur => ({ terms: [...(cur?.terms ?? []), 'cache key'] }))
  expect(await partOf(s.$, 't1-row-0', 'squeeze')).toEqual({ at: { length: -1 } })
  expect(await partOf(s.$, 't1-row-0', 'explain')).toEqual({ terms: ['cache key'] })
  expect(await setPart(s.$, 'no-such-row', 'squeeze', {})).toBe(false)
  await setPart(s.$, 't1-row-0', 'squeeze', null)
  expect(await partOf(s.$, 't1-row-0', 'squeeze')).toBe(null)
  // a turn that ran when the session ended
  await s.call('prompt.submit', { text: 'One more?', origin: { kind: 'composer' } })
  await s.call('turn.start', { text: 'One more?', turnId: 't3' })
  await settle()

  const r = setup(s.files)
  await r.call('session.start', { cwd: '/made-up/data' }, async () => ({}))
  await restoreAnswers(r.$)
  expect((await turnsNow(r.$)).map(t => [t.turnId, t.n, t.reason])).toEqual([['t1', 1, 'answer'], ['t2', 2, 'answer'], ['t3', 3, 'aborted']])
  expect(await partOf(r.$, 't1-row-0', 'explain')).toEqual({ terms: ['cache key'] })
  expect(await actingRow(r.$)).toBe('t2-row-0')
})
