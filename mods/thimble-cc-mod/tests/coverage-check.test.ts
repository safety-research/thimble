// The coverage check after an answer (harness.tsx critiqueOf, register.tsx turn.complete): after an answer that speaks
// for the whole corpus while a file was never opened, the check's text shows under the answer, and main reads the same
// words with the analyst's next prompt. Main starts no turn for it, and no subagent carries it.
// `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { parseMarks } from '../hooks/cite'

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
// an answer that speaks for the corpus as a whole, with no citation (so no fix round starts)
const ANSWER = `## Every agent edits link pages\n\nAll nine agents edit pages, and most of their edits fix links. ${'More words. '.repeat(40)}`
const CHECK = 'Coverage check: this session has read 1 of 3 files · 0.2% of records · 1 only counted by code · 1 never opened. No call opened this kind of file: pages.jsonl (500 records). Code counted over this kind of file, but no call showed any of its records: labels.jsonl (1,500 records). The answer speaks for the corpus as a whole but rests only on the files read.'

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
const MESSAGE = (text: string) => ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 60 }, props: { text, isFirstOfReply: true } }) as never
const appendRow = ($: { session: { append: (args: never) => Promise<unknown> } }, uuid: string, text: string) =>
  $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
const isCheck = (c: string) => c.includes('coverage check under your last answer')

test('after an answer that speaks for the whole corpus while a file was never opened, the check shows under it whole; main starts no turn and no subagent carries it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'what do the agents do?', turnId: 't1' } as never)
  await appendRow($, 'm1', ANSWER)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer' } as never)
  // no subagent, and nothing reaches main's chat as a prompt of its own
  expect(w.spawned).toEqual([])
  expect(w.submitted).toEqual([])
  // under the answer: the check's words whole, after the row's label
  const ui = (await $.ui.mount(MESSAGE(ANSWER))) as unknown as M
  const row = textOf(await ui.find({ key: 'check:m1' }))
  expect(row).toBe(`coverage${CHECK.replace(/^Coverage check: /, '')}`)
  // the answer has no citation or card: no footer
  expect(await ui.find({ key: 'footer:m1' })).toBeUndefined()
  await ui.unmount()
  // main reads the same words with the analyst's next prompt, once
  await $.prompt.submit({ text: 'and the deletions?', origin: { kind: 'composer' } } as never)
  const note = w.contexts.at(-1)!.filter(isCheck)
  expect(note).toHaveLength(1)
  expect(note[0]).toContain(`"${CHECK}"`)
  expect(note[0]).toMatch(/python3 \S+\/helper\/coverage\.py/)
  await $.prompt.submit({ text: 'and the requests?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.some(isCheck)).toBe(false)
})

test('a short answer, or an answer once the check is off, gets none', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'how many files?', turnId: 't1' } as never)
  await appendRow($, 'm1', 'Three.')
  await $.turn.complete({ turnId: 't1', answer: 'Three.', durationMs: 5, reason: 'answer' } as never)
  await $.command.run({ command: 'thimble-coverage', args: 'check off' } as never)
  await $.turn.start({ text: 'what do the agents do?', turnId: 't2' } as never)
  await appendRow($, 'm2', ANSWER)
  await $.turn.complete({ turnId: 't2', answer: ANSWER, durationMs: 5, reason: 'answer' } as never)
  await $.command.run({ command: 'thimble-coverage', args: 'check on' } as never)
  await $.prompt.submit({ text: 'and?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)!.some(isCheck)).toBe(false)
  expect(w.spawned).toEqual([])
})

test('an answer with citations keeps its footer, the check under it; marks.json keeps the check for a resumed session', async ($, on) => {
  const w = world(on)
  const cited = `${ANSWER}\n\nSee [[pages.jsonl#L3]].`
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'what do the agents do?', turnId: 't1' } as never)
  await appendRow($, 'm1', cited)
  await $.turn.complete({ turnId: 't1', answer: cited, durationMs: 5, reason: 'answer' } as never)
  const ui = (await $.ui.mount(MESSAGE(cited))) as unknown as M
  expect(await ui.find({ key: 'footer:m1' })).toBeDefined()
  expect(textOf(await ui.find({ key: 'check:m1' }))).toContain('No call opened this kind of file: pages.jsonl (500 records).')
  await ui.unmount()
  const marks = JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/marks.json`)!) as { ends: Record<string, { check?: string }> }
  expect(marks.ends.m1!.check).toBe(CHECK)
  expect(parseMarks(JSON.stringify(marks)).ends.m1!.check).toBe(CHECK)
})
