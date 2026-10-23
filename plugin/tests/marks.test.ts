// Marks across one reply (marks/checker.ts, view.ts): a reply with marks starts one checker fork with the marks filled
// into its text; the fork's answer, once validated, gives each mark its status, the footer and what main reads next; a
// refusal, a validator that fails, a fork that is gone and an interrupted reply leave the marks failed (the check did
// not run) with one failure line, and x starts their check; the checker may only read, and run code as one Python
// script. All data is made up.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { awaitsCheck, checkerDenial, checkerPrompt, endCheck, launchRepair, noteRow, PER_FORK, repairOf, resumeChecks, splitMarks, startCheck } from '../marks/checker'
import { marksIn } from '../marks/message.js'
import { restoreMarks, rowMarks } from '../marks/store'
import { citeLook, footerEl, messageEl } from '../marks/view'
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
/** Every element of a drawing. */
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  return out
}

async function drawn($: Any): Promise<string> {
  const reply = await rowMarks($, 'row-1')
  const marks = marksIn(REPLY)
  const looks = marks.map((_m: Any, k: number) => ({ n: k + 1, status: reply!.items[k]!.status, shown: reply!.items[k]!.shown }))
  const body = messageEl(ELS, { text: REPLY, marks, looks, key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined })
  const foot = footerEl(ELS, { key: 'f', spin: '⠋', checking: reply!.checking })
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
  expect(checking).toContain('checking 3 citations')
  expect(checking).not.toContain('(#)')

  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  // the validator read the fork's real Bash call
  expect(JSON.parse(seen.stdin[0]!).calls[0]).toEqual({ command: "python3 - <<'PY'\nprint('12 of 40')\nPY", output: '12 of 40', by: 'checker' })
  const settled = await drawn($)
  expect(settled).toContain('merged 12 of 40.')
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

test('a refused check leaves the marks failed, says so once, and nothing spins', async () => {
  const { $, seen } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'refusal', answer: '' })
  const out = await drawn($)
  // the marks draw failed, each with its reason; the failure line, not a footer, says why
  expect(out).toContain('"ship it" ×')
  expect(out.match(/ ×/g)?.length).toBe(3)
  expect(out).not.toContain('not checked')
  expect(out).not.toContain('checking')
  expect(out).not.toContain('?')
  const items = (await rowMarks($, 'row-1'))!.items
  expect(items.map(m => [m.status, m.failedBy, m.reason])).toEqual(Array(3).fill(['failed', 'none', "The check did not run. The model's safeguards refused it."]))
  // a check that did not run is no finding of the check's: main is not told of it
  expect(Object.keys(((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>)).toEqual([])
  const line = String((await failLineNow($))?.text ?? '')
  expect(line).toContain("safeguards refused the check of the citations")
  expect(line).toContain('/model')
})

test('a validator that cannot run, or a fork that is gone, leaves no mark checking and says so', async () => {
  const { $ } = engine(() => { throw new Error('made-up: the command ran past its time limit') })
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items.map(m => [m.status, m.failedBy, m.reason])).toEqual(Array(3).fill(['failed', 'none', 'The check did not run. thimble could not validate its answer.']))
  expect((await rowMarks($, 'row-1'))!.failed).toBe(3)
  expect(String((await failLineNow($))?.text)).toContain('thimble could not validate the check of the citations (made-up: the command ran past its time limit)')
  expect(String((await failLineNow($))?.text)).toContain('Press x on one in the tray to check it.')
  expect((await $.state.get({ plugin: 'thimble', key: 'marksRunning' })).value).toEqual({})
  // a reload of the plugin finds a check whose fork Claude Code no longer runs
  const { $: other } = engine(VALIDATED)
  await noteRow(other, 'row-1', REPLY)
  await startCheck(other, { turnId: 't-1', reason: 'answer' })
  await resumeChecks(other)
  expect((await rowMarks(other, 'row-1'))!.checking).toBe(0)
  expect((await rowMarks(other, 'row-1'))!.items[0]).toMatchObject({ status: 'failed', failedBy: 'none', reason: 'The check did not run. thimble lost the copy that checked it.' })
  expect(String((await failLineNow(other))?.text)).toContain('thimble lost the copy that checked them')
})

test("an interrupted reply's citations fail at once: their check did not run, and x starts it", async () => {
  const { $, seen } = engine(() => ({ exitCode: 0, stdout: JSON.stringify({ parsed: true, results: [{ n: 2, status: 'verified', shown: '15 of 40', reason: 'counted' }] }), stderr: '' }))
  await noteRow($, 'row-1', REPLY)
  // while main's turn ends, its rows wait for their check (the reply draws them pending, not failed)
  expect(await awaitsCheck($, 'row-1')).toBe(true)
  await startCheck($, { turnId: 't-1', reason: 'aborted' })
  expect(await awaitsCheck($, 'row-1')).toBe(false)
  expect(seen.spawned.length).toBe(0)
  const reply = await rowMarks($, 'row-1')
  expect(reply!.items.map(m => [m.status, m.failedBy, m.reason])).toEqual(Array(3).fill(['failed', 'none', 'The check did not run. The reply was interrupted.']))
  expect([reply!.failed, reply!.checking, reply!.verified]).toEqual([3, 0, 0])
  expect(await drawn($)).toContain('15 of 40 ×')
  // x: the check itself, of that one citation
  const r = await repairOf($, 'row-1', 2)
  expect(typeof r).toBe('object')
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  expect(seen.spawned[0].prompt).toBe('CHECK\n2. [15 of 40] in: Of the [40] pull requests, agent-07 merged [15 of 40].\nIN /made-up/data\n\nThe analyst pressed x to check citation 2, whose first check did not run. It may stand in an earlier reply than your last.')
  // it spins until its check ends, then shows what the check found
  expect(await drawn($)).toContain('15 of 40 ⠋')
  expect((await rowMarks($, 'row-1'))!.items[1]).toMatchObject({ status: 'checking', repair: true })
  expect((await rowMarks($, 'row-1'))!.items[1]!.reason).toBeUndefined()
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items[1]).toMatchObject({ status: 'verified', shown: '15 of 40', repair: true })
  const told = ((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['marks:row-1:repair:2']).toContain('- "15 of 40" is verified as written')
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

test('a resumed session draws the marks as their check left them; a check the session ended did not run (failed)', async () => {
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
  expect([first!.verified, first!.corrected, first!.failed]).toEqual([2, 1, 1])
  const second = await rowMarks(resumed, 'row-2')
  expect(second!.items[0]).toMatchObject({ status: 'failed', failedBy: 'none', reason: 'The check did not run. The session ended before it did.' })
  expect([second!.checking, second!.failed]).toEqual([0, 1])
  // a mark an earlier thimble kept as unchecked is failed too
  const key = [...files.keys()].find(k => k.endsWith('/marks/row-2.json'))!
  files.set(key, JSON.stringify({ ...JSON.parse(files.get(key)!), key: 'row-2', items: [{ ...JSON.parse(files.get(key)!).items[0], status: 'unchecked', reason: 'old words' }] }))
  const { $: again } = engine(VALIDATED, files)
  await restoreMarks(again)
  expect((await rowMarks(again, 'row-2'))!.items[0]).toMatchObject({ status: 'failed', failedBy: 'none', reason: 'The check did not run.' })
})

test('a corrected citation draws as a settled one (underlined on the purple tint); a failed one red with ×, whatever failed it; each underlined', () => {
  const text = 'Merged [15 of 40](#), opened [7](#), closed [3](#).'
  const marks = marksIn(text)
  const looks = [{ n: 1, status: 'corrected', shown: '12 of 40' }, { n: 2, status: 'failed' }, { n: 3, status: 'failed' }] as Any
  const els = all(messageEl(ELS, { text, marks, looks, key: 'k', cols: 100, first: true, spin: '', onMark: () => undefined }))
  const look = (words: string) => els.find(n => n.type === 'Text' && n.props.children === words)?.props
  expect(look('12 of 40')).toEqual({ children: '12 of 40', ...citeLook() })
  expect(look('7')).toEqual({ children: '7', color: 'error', underline: true })
  expect(look('3')).toEqual({ children: '3', color: 'error', underline: true })
  expect(els.filter(n => n.type === 'Text' && n.props.children === ' ×').length).toBe(2)
  expect(look(' ×')?.underline).toBeUndefined()
  expect(look(' ×')?.backgroundColor).toBeUndefined()
  expect(look(' ×')).toMatchObject({ color: 'error' })
  // the tint of each theme set
  expect(citeLook('dark')).toEqual({ underline: true, backgroundColor: '#423054' })
  expect(citeLook('light')).toEqual({ underline: true, backgroundColor: '#f3e6ff' })
  // without a gutter (a reply inside the tray's frame) no margin cell stands before its rows: they start at the left
  const rowsOf = (gutter?: boolean) => messageEl(ELS, { text, marks, looks, key: 'k', cols: 100, first: false, spin: '', gutter, onMark: () => undefined }).props.children
  expect(rowsOf()[0].props.children[0].props.width).toBe(2)
  expect(rowsOf(false)[0].props.children.length).toBe(1)
  expect(rowsOf(false)[0].props.children[0].props.width).toBe(100)
  // the footer says only that the check runs
  expect(footerEl(ELS, { key: 'f', spin: '⠋', checking: 0 })).toBe(null)
  expect(textOf(footerEl(ELS, { key: 'f', spin: '⠋', checking: 1 }))).toBe('⠋ checking 1 citation')
})

test("a narrowed citation: only the part the check cited is the mark; Claude's own words around it stay, as plain words", () => {
  const text = 'Most are by [one user, "Kalmbot", with the summary "Seite gelöscht." ("page deleted")](#).'
  const marks = marksIn(text)
  const looks = [{ n: 1, status: 'corrected', shown: 'one user, “Kalmbot”, with the summary “Seite gelöscht.”', narrowed: true }] as Any
  const els = all(messageEl(ELS, { text, marks, looks, key: 'k', cols: 200, first: true, spin: '', onMark: () => undefined }))
  const texts = els.filter(n => n.type === 'Text' && typeof n.props.children === 'string')
  const cited = texts.find(n => n.props.children === 'one user, "Kalmbot", with the summary "Seite gelöscht."')
  expect(cited?.props).toMatchObject(citeLook())
  const rest = texts.find(n => String(n.props.children).includes('("page deleted")'))
  expect(rest).toBeDefined()
  expect(rest!.props.underline).toBeUndefined()
  expect(rest!.props.color).toBeUndefined()
  expect(textOf(messageEl(ELS, { text, marks, looks, key: 'k', cols: 200, first: true, spin: '', onMark: () => undefined }))).toContain('Most are by one user, "Kalmbot", with the summary "Seite gelöscht." ("page deleted").')
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
  expect(seen.spawned[1].prompt).toBe('CHECK\n3. ["ship it"] in: It said ["ship it"].\nIN /made-up/data\n\nThe analyst pressed x to repair citation 3. It may stand in an earlier reply than your last. The first check found it wrong: "no record holds these words"\nCheck it again from the start, and look in the records for the right value. When you find it, answer `corrected` with the true words and the evidence that shows them.\nWhen the value is right but the cited words also hold your own words that no record shows, such as a translation or an explanation, answer `narrowed` with only the part of the cited words that the evidence shows.')
  // while it runs the citation spins; the other marks keep their results; no second repair of it starts
  expect(await drawn($)).toContain('"ship it" ⠋')
  expect(await drawn($)).toContain('merged 12 of 40.')
  expect(await repairOf($, 'row-1', 3)).toBe(null)
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  const m = (await rowMarks($, 'row-1'))!.items[2]!
  expect(m).toMatchObject({ status: 'corrected', shown: '"ship it now"', was: '"ship it"', repair: true })
  expect(await drawn($)).toContain('"ship it now"')
  const told = ((await $.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['marks:row-1:repair:3']).toContain('The analyst pressed x (repair) on a citation of yours')
  expect(told['marks:row-1:repair:3']).toContain('- "ship it" is corrected to "ship it now" (the check: "line 9 holds these words")')
  // the reply's own report stays as its check left it
  expect(told['marks:row-1']).toContain('"ship it" is flagged as wrong')
})

test('a repair whose fork does not start leaves the citation as it was and says why', async () => {
  const { $ } = engine(VALIDATED)
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: FORK, reason: 'answer', answer: '```json\n[]\n```' })
  $.agent.spawn = async () => ({ deny: 'made-up: no agents now' })
  const why = await launchRepair($, (await repairOf($, 'row-1', 3)) as Any, { until: 0, cancelled: false })
  expect(why).toContain('The repair did not start (made-up: no agents now)')
  expect((await rowMarks($, 'row-1'))!.items[2]!.status).toBe('failed')
})
