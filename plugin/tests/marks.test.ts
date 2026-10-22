// Marks across one reply (marks/checker.ts, view.ts): a reply with marks starts one checker fork with the marks filled
// into its text; the fork's answer, once validated, gives each mark its status, the footer and what main reads next; a
// refusal leaves the marks unchecked with one failure line; the checker may only read. All data is made up.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { allowedTool, endCheck, marksOf, noteRow, PER_FORK, splitMarks, startCheck } from '../marks/checker'
import { marksIn } from '../marks/message.js'
import { footerEl, messageEl } from '../marks/view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FORK = 'a0f0e0d0c0b0a0901'
const REPLY = 'Of the [40](#) pull requests, agent-07 merged [15 of 40](#).\n\nIt said ["ship it"](#).'
const VALIDATED = { parsed: true, results: [
  { n: 1, status: 'verified', shown: '40', reason: 'counted' },
  { n: 2, status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'agent-07 merged 12' },
  { n: 3, status: 'failed', shown: '"ship it"', reason: 'no record holds these words' },
] }

/** An engine with versioned state, a fork that starts, and a validator that answers `validated`. */
function engine(validated: Any) {
  const state = new Map<string, { value: unknown; version: number }>()
  const seen = { spawned: [] as Any[], toasts: [] as string[], stdin: [] as string[] }
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', THIMBLE_PYTHON: '/made-up/python3' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: {
      cwd: async () => '/made-up/data',
      id: async () => 's-marks',
      messages: async (a?: Any) => (a?.agentId === FORK
        ? [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: "python3 - <<'PY'\nprint('12 of 40')\nPY" }, text: '12 of 40' }] }]
        : []),
    },
    fs: { read: async (p: string) => (p.endsWith('/prompts/checker.md') ? 'CHECK\n{marks}\nIN {cwd}' : ''), exists: async () => false },
    agent: { spawn: async (a: Any) => { seen.spawned.push(a); return { model: 'claude-opus-5-5', agentId: FORK } } },
    process: { run: async (_argv: string[], init: Any) => { seen.stdin.push(String(init?.stdin ?? '')); return { exitCode: 0, stdout: JSON.stringify(validated), stderr: '' } } },
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
    ui: { toast: (t: string) => { seen.toasts.push(t) } },
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

/** The reply's row as the renderer draws it from the state. */
async function drawn($: Any): Promise<string> {
  const reply = await marksOf($, 'row-1')
  const marks = marksIn(REPLY)
  const looks = marks.map((_m: Any, k: number) => ({ n: k + 1, status: reply!.items[k]!.status, shown: reply!.items[k]!.shown }))
  const body = messageEl(ELS, { text: REPLY, marks, looks, key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined })
  const foot = footerEl(ELS, { key: 'f', spin: '⠋', checking: reply!.checking ? reply!.total : 0, failed: reply!.failed, unchecked: reply!.unchecked })
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
  expect(JSON.parse(seen.stdin[0]!).calls).toEqual([{ command: "python3 - <<'PY'\nprint('12 of 40')\nPY", output: '12 of 40', by: 'checker' }])
  const settled = await drawn($)
  expect(settled).toContain('merged 12 of 40.')
  expect(settled).toContain('"ship it" ×')
  expect(settled).toContain('1 mark failed')
  expect(settled).not.toContain('checking')
  const told = Object.values(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain('"15 of 40" is corrected to "12 of 40"')
  expect(told).toContain('failed: no record holds these words')
  expect(seen.toasts.length).toBe(0)
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
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain('Safeguards refused the check of the marks')
  expect(seen.toasts[0]).toContain('/model')
})

test('the checker reads only: Read, Grep, Glob and Bash, never Edit or Write', () => {
  expect(['Read', 'Grep', 'Glob', 'Bash'].every(allowedTool)).toBe(true)
  expect(['Edit', 'Write', 'NotebookEdit', 'Agent'].some(allowedTool)).toBe(false)
})

test('a reply with many marks is split between forks, a sentence never across two', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ n: i + 1, words: String(i), start: 0, end: 0, sentence: `s${Math.floor(i / 3)}`, status: 'checking' as const, shown: String(i) }))
  const shares = splitMarks(items)
  expect(shares.length).toBe(Math.ceil(25 / PER_FORK))
  expect(shares.flat().map(m => m.n)).toEqual(items.map(m => m.n))
  for (let k = 1; k < shares.length; k++) expect(shares[k]![0]!.sentence).not.toBe(shares[k - 1]!.at(-1)!.sentence)
  expect(splitMarks(items.slice(0, PER_FORK)).length).toBe(1)
})
