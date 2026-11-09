// Marks across one reply (marks/checker.ts, view.ts): a reply with marks starts one checker fork with the marks filled
// into its text; the fork's answer, once validated, gives each mark its status and what main reads next; a citation the
// check finds wrong is repaired at once, and x checks one again; the checker may only read, and run code as one Python
// script. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { autoRepair, checkerDenial, checkerPrompt, endCheck, launchRepair, noteRow, repairOf, startCheck } from '../marks/checker'
import { setOptions } from '../settings/features.mjs'
import { marksIn } from '../marks/message.js'
import { rowMarks } from '../marks/store'
import { messageEl } from '../marks/view'
import { NOTICES, tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// these tests check each reply's citations after the reply (Citations: auto cite + verify); the tests of the other modes
// set their own
setOptions({ citations: 'auto cite + verify' })

const FORK = 'a0f0e0d0c0b0a0901'
const REPLY = 'Of the [40](#) pull requests, agent-07 merged [15 of 40](#).\n\nIt said ["ship it"](#).'
const VALIDATED = { parsed: true, results: [
  { n: 1, status: 'verified', shown: '40', reason: 'counted', note: 'agent-07 merged none of them alone: agent-02 approved each one.' },
  { n: 2, status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'agent-07 merged 12' },
  { n: 3, status: 'failed', shown: '"ship it"', reason: 'no record holds these words' },
] }

/** An engine with versioned state, files, forks that start, and a validator that answers `validated` (a function: what
 *  the validator does with its input). */
function engine(validated: Any) {
  const files = new Map<string, string>()
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
        if (p.endsWith('/prompts/notices.md')) return NOTICES
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
  return { $, seen }
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

async function drawn($: Any): Promise<string> {
  const reply = await rowMarks($, 'row-1')
  const marks = marksIn(REPLY)
  const looks = marks.map((_m: Any, k: number) => ({ n: k + 1, status: reply!.items[k]!.status, shown: reply!.items[k]!.shown }))
  const body = messageEl(ELS, { text: REPLY, marks, looks, key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined })
  return textOf(body)
}

test('a reply with marks starts one checker fork with its marks filled in, and its answer settles them', async () => {
  const { $, seen } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  expect(seen.spawned.length).toBe(1)
  expect(seen.spawned[0].subagentType).toBe('fork')
  expect(seen.spawned[0].prompt).toBe('CHECK\n1. [40] in: Of the [40] pull requests, agent-07 merged [15 of 40].\n2. [15 of 40] in: Of the [40] pull requests, agent-07 merged [15 of 40].\n3. ["ship it"] in: It said ["ship it"].\nIN /made-up/data')
  const checking = await drawn($)
  // each citation turns after its words until its own verdict arrives; no line under the reply counts them
  expect(checking).toContain('Of the 40 ⠋ pull requests, agent-07 merged 15 of 40 ⠋.')
  expect(checking).toContain('"ship it" ⠋')
  expect(checking).not.toContain('checking 3 citations')
  expect(checking).not.toContain('(#)')

  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  // the validator read the fork's real Bash call
  expect(JSON.parse(seen.stdin[0]!).calls[0]).toEqual({ command: "python3 - <<'PY'\nprint('12 of 40')\nPY", output: '12 of 40', by: 'checker' })
  const settled = await drawn($)
  // the corrected words in place, with no sign after them; the failed one red, with × after it
  expect(settled).toContain('merged 12 of 40.')
  expect(settled).not.toContain('*')
  expect(settled).toContain('"ship it" ×')
  // once settled no footer counts the marks: each shows its own status where it stands
  expect(settled).not.toContain('citation wrong')
  expect(settled).not.toContain('1 corrected')
  // the check's note on the first sentence is not shown to the person: main reads it with the next prompt (below)
  expect(settled).not.toContain('agent-02 approved each one')
  expect(settled).not.toContain('↳')
  expect(settled).not.toContain('checking')
  const told = Object.values(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain('"15 of 40" is corrected to "12 of 40"')
  expect(told).toContain('"ship it" is flagged as wrong (the check: "no record holds these words")')
  expect(told).toContain('The analyst does not see these')
  expect(told).toContain('- "agent-07 merged none of them alone: agent-02 approved each one."')
  expect(told).toContain('The analyst has read the changes in the reply, so do not repeat them.')
  expect(await failLineNow($)).toBe(null)
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

test('x on a wrong citation checks it again in a fork of its own; its answer corrects it in place and main reads how it ended', async () => {
  let runs = 0
  const repaired = { parsed: true, results: [{ n: 3, status: 'corrected', shown: '"ship it now"', was: '"ship it"', reason: 'line 9 holds these words' }] }
  const { $, seen } = engine(() => ({ exitCode: 0, stdout: JSON.stringify(runs++ ? repaired : VALIDATED), stderr: '' }))
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  // a verified citation has nothing to repair
  expect(await repairOf($, 'row-1', 1)).toBe(null)
  const r = await repairOf($, 'row-1', 3)
  expect(typeof r).toBe('object')
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  expect(seen.spawned.length).toBe(2)
  expect(seen.spawned[1].description).toBe('checking a citation again (x)')
  expect(seen.spawned[1].prompt).toBe('CHECK\n3. ["ship it"] in: It said ["ship it"].\nIN /made-up/data\n\nThe analyst pressed x on citation 3 to repair it. It may stand in an earlier reply than your last. The first check found it wrong: "no record holds these words"\nCheck it again from the start. When the cited words hold, answer `verified`. Otherwise, make the citation correct and answer `corrected`. When the value is right but the cited words add your own words, answer `narrowed`.')
  // while it runs the citation spins; the other marks keep their results; no second repair of it starts
  expect(await drawn($)).toContain('"ship it" ⠋')
  expect(await drawn($)).toContain('merged 12 of 40.')
  expect(await repairOf($, 'row-1', 3)).toBe(null)
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  const m = (await rowMarks($, 'row-1'))!.items[2]!
  expect(m).toMatchObject({ status: 'corrected', shown: '"ship it now"', was: '"ship it"', repair: true })
  expect(await drawn($)).toContain('"ship it now"')
  const told = ((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['marks:row-1:repair:3']).toContain('The analyst pressed x on a citation of yours')
  expect(told['marks:row-1:repair:3']).toContain('- "ship it" is corrected to "ship it now" (the check: "line 9 holds these words")')
  // the reply's own report stays as its check left it
  expect(told['marks:row-1']).toContain('"ship it" is flagged as wrong')
})

/** thimble's own request for a repair of citation 3 of REPLY, which the check found wrong, right after that check: what
 *  the repair's fork reads under the checker's text. It says thimble asked, where x's says the analyst pressed x. */
const AUTO_3 = 'CHECK\n3. ["ship it"] in: It said ["ship it"].\nIN /made-up/data\n\nthimble asks you to repair citation 3. It may stand in an earlier reply than your last. The first check found it wrong: "no record holds these words"\nCheck it again from the start. When the cited words hold, answer `verified`. Otherwise, make the citation correct and answer `corrected`. When the value is right but the cited words add your own words, answer `narrowed`.'

test("a check that fails a citation repairs it at once, with a request that says thimble asked: it spins as for x, and the repair's answer replaces it", async () => {
  let runs = 0
  const repaired = { parsed: true, results: [{ n: 3, status: 'corrected', shown: '"ship it now"', was: '"ship it"', reason: 'line 9 holds these words' }] }
  const { $, seen } = engine(() => ({ exitCode: 0, stdout: JSON.stringify(runs++ ? repaired : VALIDATED), stderr: '' }))
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items[2]!.status).toBe('failed')
  // the hook around endCheck's: the failed citation's repair starts, one fork, whose request says thimble asked
  await autoRepair($, FORK)
  expect(seen.spawned.length).toBe(2)
  expect(seen.spawned[1].description).toBe('checking a citation again (x)')
  expect(seen.spawned[1].prompt).toBe(AUTO_3)
  expect((await rowMarks($, 'row-1'))!.items[2]).toMatchObject({ status: 'checking', repair: true })
  expect(await drawn($)).toContain('"ship it" ⠋')
  expect(await drawn($)).toContain('merged 12 of 40.')
  // started once: the same check's end again, or x while it runs, starts no other
  await autoRepair($, FORK)
  expect(await repairOf($, 'row-1', 3)).toBe(null)
  expect(seen.spawned.length).toBe(2)
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items[2]).toMatchObject({ status: 'corrected', shown: '"ship it now"', was: '"ship it"', repair: true })
  expect(await drawn($)).toContain('"ship it now"')
  // main reads that thimble checked it again, not that the analyst pressed x
  const told = ((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['marks:row-1:repair:3']).toContain('A citation of yours failed its check, so thimble checked it again against the data.')
  expect(told['marks:row-1:repair:3']).not.toContain('pressed x')
  expect(told['marks:row-1:repair:3']).toContain('- "ship it" is corrected to "ship it now" (the check: "line 9 holds these words")')
  expect(told['marks:row-1']).toContain('"ship it" is flagged as wrong')
})
