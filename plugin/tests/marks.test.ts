// Marks across one reply (marks/checker.ts, view.ts): a reply with marks starts one checker fork with the marks filled
// into its text; the fork's answer, once validated, gives each mark its status, the footer and what main reads next; a
// refusal, a validator that fails and a fork that is gone leave the marks unchecked with one failure line; the checker
// may only read, and run code as one Python script. All data is made up.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { checkerDenial, checkerPrompt, endCheck, noteRow, PER_FORK, resumeChecks, splitMarks, startCheck } from '../marks/checker'
import { marksIn } from '../marks/message.js'
import { notesByMark, restoreMarks, rowMarks } from '../marks/store'
import { footerEl, messageEl } from '../marks/view'
import { tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FORK = 'a0f0e0d0c0b0a0901'
const REPLY = 'Of the [40](#) pull requests, agent-07 merged [15 of 40](#).\n\nIt said ["ship it"](#).'
const VALIDATED = { parsed: true, results: [
  { n: 1, status: 'verified', shown: '40', reason: 'counted', note: 'agent-07 merged none of them alone: agent-02 approved each one.' },
  { n: 2, status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'agent-07 merged 12' },
  { n: 3, status: 'failed', shown: '"ship it"', reason: 'no record holds these words' },
] }

/** An engine with versioned state, files, forks that start, and a validator that answers `validated` (a function: what
 *  the validator does with its input). */
function engine(validated: Any, files = new Map<string, string>()) {
  const state = new Map<string, { value: unknown; version: number }>()
  let forks = 0
  const seen = { spawned: [] as Any[], stdin: [] as string[] }
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: {
      cwd: async () => '/made-up/data',
      id: async () => 's-marks',
      messages: async (a?: Any) => (a?.agentId === FORK
        ? [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: "python3 - <<'PY'\nprint('12 of 40')\nPY" }, text: '12 of 40' }] }]
        : [{ role: 'assistant', text: '', toolUses: [
          { tool_use_id: 'm1', tool: 'Bash', input: { command: 'python3 count.py' }, text: 'merged:  12 of 40\nopen: 3' },
          { tool_use_id: 'm2', tool: 'Bash', input: { command: 'ls' }, text: 'a.txt b.txt' },
        ] }]),
    },
    fs: {
      read: async (p: string) => {
        if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}\nIN {{CWD}}'
        if (files.has(p)) return files.get(p)
        throw new Error(`no file ${p}`)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })),
      exists: async () => false,
    },
    process: { run: async (argv: string[], init: Any) => { const t = tempRun(argv); if (t) return t; seen.stdin.push(String(init?.stdin ?? '')); return typeof validated === 'function' ? validated(init) : { exitCode: 0, stdout: JSON.stringify(validated), stderr: '' } } },
    agent: { spawn: async (a: Any) => { seen.spawned.push(a); const agentId = forks ? `${FORK}${forks}` : FORK; forks++; return { model: 'claude-opus-5-5', agentId } }, list: async () => [] },
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
    clock: { now: async () => (now += 100), after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
  }
  return { $, seen, files }
}

/** Elements as plain objects, and their words. */
const el = (type: string) => (props: Any) => ({ type, props })
const ELS = { Box: el('Box'), Text: el('Text'), Button: el('Button'), Markdown: el('Markdown'), Code: el('Code') }
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '')
}

/** The reply's row as the renderer draws it from the state. */
async function drawn($: Any): Promise<string> {
  const reply = await rowMarks($, 'row-1')
  const marks = marksIn(REPLY)
  const looks = marks.map((_m: Any, k: number) => ({ n: k + 1, status: reply!.items[k]!.status, shown: reply!.items[k]!.shown }))
  const body = messageEl(ELS, { text: REPLY, marks, looks, key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined, notes: notesByMark(reply!.items) })
  const foot = footerEl(ELS, { key: 'f', spin: '⠋', checking: reply!.checking, wrong: reply!.wrong, unconfirmed: reply!.unconfirmed, corrected: reply!.corrected, unchecked: reply!.unchecked })
  return textOf(body) + '\n' + textOf(foot)
}

test('a reply with marks starts one checker fork with its marks filled in, and its answer settles them', async () => {
  const { $, seen } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  expect(seen.spawned.length).toBe(1)
  expect(seen.spawned[0].subagentType).toBe('fork')
  expect(seen.spawned[0].prompt).toBe('CHECK\n1. [40] in: Of the [40] pull requests, agent-07 merged [15 of 40].\n2. [15 of 40] in: Of the [40] pull requests, agent-07 merged [15 of 40].\n3. ["ship it"] in: It said ["ship it"].\nIN /made-up/data')
  const checking = await drawn($)
  expect(checking).toContain('15 of 40 ⠋')
  expect(checking).toContain('checking 3 marks')
  expect(checking).not.toContain('(#)')

  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  // the validator read the fork's real Bash call
  expect(JSON.parse(seen.stdin[0]!).calls[0]).toEqual({ command: "python3 - <<'PY'\nprint('12 of 40')\nPY", output: '12 of 40', by: 'checker' })
  const settled = await drawn($)
  expect(settled).toContain('merged 12 of 40.')
  expect(settled).toContain('"ship it" ×')
  expect(settled).toContain('1 mark wrong · 1 corrected')
  // the note on the first sentence, once, under the block that holds it
  expect(settled.split('agent-02 approved each one').length).toBe(2)
  expect(settled).toContain('↳ agent-07 merged none of them alone')
  expect(settled).not.toContain('checking')
  const told = Object.values(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain('"15 of 40" is corrected to "12 of 40"')
  expect(told).toContain('"ship it" is marked as wrong (the check: "no record holds these words")')
  expect(told).toContain('- "agent-07 merged none of them alone: agent-02 approved each one."')
  expect(told).toContain('would tell them twice')
  expect(await failLineNow($)).toBe(null)
})

test("the validator gets the fork's calls and main's (it keeps main's whose output the check cites)", async () => {
  const { $, seen } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[{"mark": 2, "evidence": {"output": ["merged: 12 of 40", "open"]}}]\n```' })
  expect(JSON.parse(seen.stdin[0]!).calls.map((c: Any) => [c.command, c.by])).toEqual([["python3 - <<'PY'\nprint('12 of 40')\nPY", 'checker'], ['python3 count.py', 'main'], ['ls', 'main']])
})

test('a refused check leaves the marks unchecked, says so once, and nothing spins', async () => {
  const { $, seen } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'refusal', answer: '' })
  const out = await drawn($)
  expect(out).toContain('3 marks not checked')
  expect(out).not.toContain('checking')
  expect(out).not.toContain('×')
  const line = String((await failLineNow($))?.text ?? '')
  expect(line).toContain("safeguards refused the check of the marks")
  expect(line).toContain('/model')
})

test('a validator that cannot run, or a fork that is gone, leaves no mark checking and says so', async () => {
  const { $ } = engine(() => { throw new Error('made-up: the command ran past its time limit') })
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items.map(m => m.status)).toEqual(['unchecked', 'unchecked', 'unchecked'])
  expect(String((await failLineNow($))?.text)).toContain('thimble could not validate the check of the marks (made-up: the command ran past its time limit)')
  expect((await $.state.get({ plugin: 'thimble', key: 'marksRunning' })).value).toEqual({})
  // a reload of the plugin finds a check whose fork Claude Code no longer runs
  const { $: other } = engine(VALIDATED)
  await noteRow(other, 'row-1', REPLY)
  await startCheck(other, { turnId: 't-1', reason: 'answer' })
  await resumeChecks(other)
  expect((await rowMarks(other, 'row-1'))!.checking).toBe(0)
  expect(String((await failLineNow(other))?.text)).toContain('thimble lost the copy that checked them')
})

test("the checker reads files, and runs code only as one Python script; a mark's sentence goes in its prompt as written", () => {
  const call = (tool: string, command?: string) => checkerDenial({ tool, command })
  expect(['Read', 'Grep', 'Glob'].map(t => call(t))).toEqual([null, null, null])
  expect(call('Bash', "cd /made-up/data && python3 - <<'PY'\nprint(1)\nPY")).toBe(null)
  expect(call('Bash', "cd /made-up/data\npython3 - <<'PY'\nprint(1)\nPY")).toBe(null)
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent']) expect(call(t)).toContain('only reads')
  for (const c of ['rm -rf data', "python3 - <<'PY'\nprint(1)\nPY\nrm -rf data", "python3 - <<'PY'\nprint(1)\nPY\nrm x\nPY", 'curl https://example.invalid']) expect(call('Bash', c)).toContain('one Python script')
  const item = { n: 1, row: 'r', words: '$5', start: 0, end: 0, sentence: "It cost [$5] and $' more, $$ and $&.", status: 'checking' as const, shown: '$5' }
  expect(checkerPrompt('A\n{{MARKS}}\nB {{CWD}} {{ROOT}}', [item], '/made-up/data/sub', '/made-up/data')).toBe("A\n1. [$5] in: It cost [$5] and $' more, $$ and $&.\nB /made-up/data/sub /made-up/data")
})

test('a reply with many marks is split between forks of about equal size, a sentence in one share up to its size', () => {
  const mark = (i: number, sentence: string) => ({ n: i + 1, words: String(i), start: 0, end: 0, sentence, status: 'checking' as const, shown: String(i) })
  const items = Array.from({ length: 25 }, (_, i) => mark(i, `s${Math.floor(i / 3)}`))
  const shares = splitMarks(items)
  expect(shares.length).toBe(Math.ceil(25 / PER_FORK))
  expect(shares.flat().map(m => m.n)).toEqual(items.map(m => m.n))
  for (let k = 1; k < shares.length; k++) expect(shares[k]![0]!.sentence).not.toBe(shares[k - 1]!.at(-1)!.sentence)
  expect(splitMarks(items.slice(0, PER_FORK)).length).toBe(1)
  // one mark, then a sentence of four, then one of six: no share of one beside a share of six
  const uneven = [mark(0, 'a'), ...[1, 2, 3, 4].map(i => mark(i, 'b')), ...[5, 6, 7, 8, 9, 10].map(i => mark(i, 'c'))]
  const sizes = splitMarks(uneven).map(s => s.length)
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(11)
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(3)
})

test('checker forks that end at the same moment all settle their marks, and main is told every correction once', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `Sentence ${i} has [${i + 10}](#).`).join(' ')
  const results = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, status: 'corrected', shown: String(i + 100), was: String(i + 10), reason: 'counted' }))
  const { $ } = engine({ parsed: true, results })
  await noteRow($, 'row-1', many)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await Promise.all([FORK, `${FORK}1`, `${FORK}2`].map(agentId => endCheck($, { agentId, reason: 'answer', answer: '```json\n[]\n```' })))
  const reply = await rowMarks($, 'row-1')
  expect(reply!.checking).toBe(0)
  expect(reply!.items.map(m => m.status)).toEqual(Array(12).fill('corrected'))
  const told = Object.values(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>)
  expect(told.length).toBe(1)
  for (let i = 0; i < 12; i++) expect(told[0]).toContain(`"${i + 10}" is corrected to "${i + 100}"`)
})

test('a resumed session draws the marks as their check left them; a check the session ended is not checked', async () => {
  const { $, files } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  await noteRow($, 'row-2', 'Then [7](#) more.')
  await startCheck($, { turnId: 't-2', reason: 'answer' })
  // a new process: the same files, a fresh state
  const { $: resumed } = engine(VALIDATED, files)
  await restoreMarks(resumed)
  const first = await rowMarks(resumed, 'row-1')
  expect(first!.items.map(m => [m.status, m.shown])).toEqual([['verified', '40'], ['corrected', '12 of 40'], ['failed', '"ship it"']])
  expect(first!.wrong).toBe(1)
  const second = await rowMarks(resumed, 'row-2')
  expect(second!.items[0]!.status).toBe('unchecked')
  expect(second!.checking).toBe(0)
})
