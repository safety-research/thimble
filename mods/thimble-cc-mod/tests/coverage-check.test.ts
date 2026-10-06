// The coverage check's way to main (register.tsx sendCheck): after an answer that speaks for the whole corpus while a
// file was never opened, a subagent on a small model carries the check, its hand-back takes the check to main as
// context the analyst does not see, and main's chat shows one dim line of it. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

const CWD = '/corpus/wiki'
type M = Mounted<'terminal'>
type El = { type: string; key?: string; props: Record<string, unknown>; children?: unknown[] }

const SUMMARY = {
  line: 'read 1 of 3 files · 0.2% of records · 1 only counted by code · 1 never opened',
  totals: { files: 3, read: 1, scanned: 1, untouched: 1, records: 5000, records_seen: 10, bytes: 1e6, bytes_seen: 2000 },
  kinds: [
    { kind: 'events.jsonl', files: 1, read: 1, scanned: 0, untouched: 0, records: 3000, records_seen: 10 },
    { kind: 'labels.jsonl', files: 1, read: 0, scanned: 1, untouched: 0, records: 1500, records_seen: 0 },
    { kind: 'pages.jsonl', files: 1, read: 0, scanned: 0, untouched: 1, records: 500, records_seen: 0 },
  ],
  files: [
    { file: 'events.jsonl', size: 600000, records: 3000, seen: 10, state: 'read', ranges: [[1, 5]], agents: ['main'] },
    { file: 'labels.jsonl', size: 300000, records: 1500, seen: 0, state: 'scanned', ranges: [], agents: ['main'] },
    { file: 'pages.jsonl', size: 100000, records: 500, seen: 0, state: 'untouched', ranges: [], agents: [] },
  ],
}
const LINE = 'pages.jsonl never opened · labels.jsonl only counted'
// an answer that speaks for the corpus as a whole, with no citation (so no fix round starts)
const ANSWER = `## Every agent edits link pages\n\nAll nine agents edit pages, and most of their edits fix links. ${'More words. '.repeat(40)}`
const SAID = `thimble-cc-mod coverage check: ${LINE}`
const handback = (from: string, report = SAID) =>
  `<agent-message from="${from}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n  ${report}\n</agent-message>`

type World = { files: Map<string, string>; spawned: Record<string, unknown>[]; submitted: string[]; contexts: (readonly string[])[]; deny: string }

function world(on: On): World {
  const w: World = { files: new Map(), spawned: [], submitted: [], contexts: [], deny: '' }
  mock.env(on, {})
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 's1' }))
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
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (String(e.argv[1]).endsWith('/helper/coverage.py') && e.argv[2] === 'summary') return out(JSON.stringify(SUMMARY))
    return { value: { exitCode: 1, stdout: '', stderr: 'no such script', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    w.contexts.push(e.context ?? [])
    return { text: e.text } as never
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push({ ...e })
    if (w.deny) return { deny: w.deny }
    return { model: 'claude-haiku', agentId: `agent-${w.spawned.length}` }
  })
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['(the engine row)'] }))
  return w
}

const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El)?.children ?? []).map(textOf).join(''))
const row = (props: Record<string, unknown>) => ({ plugin: 'thimble-cc-mod', component: 'UserMessage', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { origin: { kind: 'peer' }, isExpanded: false, text: SAID, from: { name: 'general-purpose' }, ...props } }) as never

async function drawn(engine: { ui: { mount: (x: never) => Promise<unknown> } }, props: Record<string, unknown>): Promise<string> {
  const ui = (await engine.ui.mount(row(props))) as unknown as M
  const t = textOf(await ui.drawn())
  await ui.unmount()
  return t
}

/** Seed a value of the mod's state, read back as the test or the mod last wrote it (as nav.test.ts's `written`). */
function seeded(on: On): Map<string, unknown> {
  const vals = new Map<string, unknown>()
  on('state.set', ($, e, next) => {
    const x = e as { key: string; value: unknown }
    if (vals.has(x.key)) vals.set(x.key, x.value)
    return next(e)
  })
  on('state.get', ($, e, next) => {
    const x = e as { key: string }
    return vals.has(x.key) ? ({ value: { value: vals.get(x.key), version: 1 } } as never) : next(e)
  })
  return vals
}

const isCheck = (c: string) => c.startsWith('Coverage check from thimble-cc-mod')

test('after an answer that speaks for the whole corpus while a file was never opened, a subagent on a small model is asked to carry the check; no prompt of the plugin', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'what do the agents do?', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer' } as never)
  // in the background, unnamed (a named agent is one SendMessage can reach later), told to say the check's line back
  // after the words its hand-back and row are known by
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatchObject({ subagent_type: 'general-purpose', model: 'haiku', description: 'coverage check', run_in_background: true })
  expect(w.spawned[0]!.name).toBeUndefined()
  expect(String(w.spawned[0]!.prompt)).toContain(SAID)
  // nothing reaches main's chat as a block
  expect(w.submitted).toEqual([])
  // the kit starts no subagent (it drops the id a hook answers), so here the check waits for the analyst's next
  // prompt and goes with it as context, once
  await $.prompt.submit({ text: 'and the deletions?', origin: { kind: 'composer' } } as never)
  const check = w.contexts.at(-1)!.filter(isCheck)
  expect(check).toHaveLength(1)
  expect(check[0]).toContain('No call opened this kind of file: pages.jsonl (500 records).')
  expect(check[0]).toMatch(/python3 \S+\/helper\/coverage\.py/)
  await $.prompt.submit({ text: 'and the requests?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.some(isCheck)).toBe(false)
})

test('the carrier\'s hand-back takes the waiting check to main as context; a second is dropped, another subagent\'s is left alone; its row is one dim line', async ($, on) => {
  const w = world(on)
  const state = seeded(on)
  state.set('coverageCheck', { agent: 'agent-7', text: 'Coverage check from thimble-cc-mod: read pages.jsonl.', line: LINE, prompt: 'what do the agents do?', at: 1 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.prompt.submit({ text: handback('agent-7'), origin: { kind: 'peer' } } as never)) as { drop?: string }
  expect(r.drop).toBeUndefined()
  expect(w.contexts.at(-1)!.filter(isCheck)).toEqual(['Coverage check from thimble-cc-mod: read pages.jsonl.'])
  expect(state.get('coverageCheck')).toBe(null)
  // the turn it starts revises the answer to the analyst's question, and its answer is filed under that question
  await $.turn.start({ text: handback('agent-7'), turnId: 't2' } as never)
  await $.turn.complete({ turnId: 't2', answer: '[[card:c1]]\n\nRevised after reading pages.jsonl.', durationMs: 5, reason: 'answer' } as never)
  const filed = [...w.files.entries()].filter(([k]) => k.startsWith(`${CWD}/.thimble-cc-mod/answers/`)).map(([, v]) => v)
  expect(filed).toHaveLength(1)
  expect(filed[0]!.startsWith('# what do the agents do?\n')).toBe(true)
  // a carrier's hand-back with no check waiting is dropped, not answered in main's chat
  const again = (await $.prompt.submit({ text: handback('agent-8'), origin: { kind: 'peer' } } as never)) as { drop?: string }
  expect(again.drop).toBe('thimble-cc-mod: coverage check · already sent')
  // another subagent's hand-back is left alone
  const other = (await $.prompt.submit({ text: handback('agent-9', 'done'), origin: { kind: 'peer' } } as never)) as { drop?: string }
  expect(other.drop).toBeUndefined()
  expect(w.contexts.at(-1)!.some(isCheck)).toBe(false)
  // the row: one dim line of the check's files; ctrl+o, and any other subagent's row, as the engine draws them
  expect(await drawn($, {})).toBe(`  coverage check · ${LINE}`)
  expect(await drawn($, { isExpanded: true })).toBe('(the engine row)')
  expect(await drawn($, { text: 'done' })).toBe('(the engine row)')
})
