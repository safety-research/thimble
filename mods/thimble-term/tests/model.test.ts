// What thimble-term reads from `thimble state` (hooks/model.ts, hooks/data.ts): a citation's check, a thread's chat as
// turns, the lists, the cards a call of main's names, main's end token, the command and the scope.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { changed, cliOf, launchMode, parsePrinted } from '../hooks/data'
import { citations } from '../hooks/lib'
import { agentsOf, cardsOfCall, cellsOf, docsOf, homeOf, labelIdOf, resolutionOf, threadOf, threadRowsOf, verdictOf, withoutEnd } from '../hooks/model'
import { AGENTS, CELLS, RESOLVE, STATES, THREAD_T1, THREADS } from './fixtures'

const check = (raw: string) => {
  const c = citations(raw)[0]!
  return verdictOf(c, resolutionOf(RESOLVE, c.ref))
}

test("a citation holds when its place shows its value, a number written another way too", () => {
  const v = check('[[4,579|README.md#L3]]')
  expect(v.status).toBe('ok')
  expect(v.path).toBe('README.md')
  const hit = v.lines.find(l => l.hit)!
  expect(hit.n).toBe(3)
  expect(hit.spans![0]).toEqual([13, 18])
  // the records around it, not lit
  expect(v.lines.find(l => l.n === 4)?.hit).toBe(false)
})

test('a citation whose place resolves without its value differs; one whose place does not resolve is missing', () => {
  expect(check('[[5000|README.md#L3]]').status).toBe('differs')
  const gone = check('[[3|README.md#L99]]')
  expect(gone.status).toBe('missing')
  expect(gone.why).toContain('out of range')
  expect(verdictOf(citations('[[x|nowhere.jsonl#L1]]')[0]!, { error: 'no such file' }).status).toBe('missing')
})

test("a card cell's citation compares its value with the cell; a citation that shows no value only needs its place", () => {
  expect(check('[[4579|card:ff73e071#pages/TOTAL]]').status).toBe('ok')
  const off = check('[[14592|card:ff73e071#revisions/TOTAL]]')
  expect(off.status).toBe('differs')
  expect(off.why).toBe('the place shows 14591')
  expect(off).toMatchObject({ card: 'ff73e071', column: 'revisions', row: 'TOTAL', value: '14591' })
  expect(check('[[README.md#L5]]').status).toBe('ok')
  // a Markdown link written for the terminal is the same citation
  expect(citations('see [4579](card:ff73e071#pages/TOTAL)')[0]!.display).toBe('4579')
  // not checked yet
  expect(verdictOf(citations('[[1|README.md#L3]]')[0]!, null).status).toBe('pending')
})

test("a thread's chat as turns: its question, its answer's text, its tool calls, answered", () => {
  const t = threadOf(THREAD_T1.meta as never, THREAD_T1.events as never)
  expect(t.turns).toEqual([{ q: 'why is events.jsonl so much bigger?', a: 'It holds [[19913|card:a0frame0#records/events.jsonl]] rows, one per event.', state: 'done', tools: 1, partial: 'It holds [[19913|card:a0frame0#records/events.jsonl]] rows, one per event.' }])
  expect(t.label).toBe('What does the export hold per wiki?')
  expect(t.parent).toBe('')
  const failed = threadOf({ id: 'x' }, [{ type: 'user', text: 'q' }, { type: 'error', error: 'stopped by the analyst' }])
  expect(failed.turns[0]).toMatchObject({ state: 'error', a: 'stopped by the analyst' })
})

test('the threads list keeps side threads, each with its answers and those not read', () => {
  const rows = threadRowsOf(THREADS)
  expect(rows.map(r => r.id)).toEqual(['t1', 't2'])
  expect(rows[0]).toMatchObject({ answers: 1, seen: 0, unread: 1, running: false, anchor: 'card:ff73e071' })
  expect(rows[1]).toMatchObject({ running: true, unread: 0 })
  expect(threadRowsOf([{ id: 'a', kind: 'thread', unread: true }])[0]!.unread).toBe(1)
})

test('the agents, the counts, the documents and the cells, from their routes', () => {
  expect(agentsOf(AGENTS)).toEqual([{ name: 'thimble:orientation', label: 'orientation: the whole corpus', state: 'working', kind: 'subagent', chat: 'o1', role: 'orientation', started: '' }])
  expect(homeOf(STATES.home)).toMatchObject({ cards: 12, labels: 1, docs: 1, threads: 2, files: 4 })
  expect(homeOf({ counts: { cards: [1, 2], labels: 0 } })).toMatchObject({ cards: 2, labels: 0 })
  expect(docsOf(STATES.docs)).toEqual([{ slug: 'report', title: 'Agents used the dse wiki as a relay', renderer: 'document', status: 'written' }])
  expect(cellsOf(STATES.cards).length).toBe(Object.keys(CELLS).length)
  expect(cellsOf([{ id: 'a' }, { nope: 1 }]).length).toBe(1)
  expect(labelIdOf(CELLS.l0label0 as never)).toBe('d9b51617')
})

test('the cards a call of main names: add_card, edit_card, apply_label, and a card run in Bash', () => {
  const add = 'mcp__plugin_thimble_thimble__add_card'
  expect(cardsOfCall(add, { question: 'q' }, 'card:8c2264f4, your last card, still has no takeaway.\n\ncard:69d6b48a\n[out0: ...]')).toEqual(['69d6b48a'])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__edit_card', { card: 'card:8c2264f4' }, 'takeaway noted')).toEqual(['8c2264f4'])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__apply_label', {}, "applied label x [[concept:e7]] over 3 record(s): yes 1. The label's card is [[card:01fee4d5]].")).toEqual(['01fee4d5'])
  expect(cardsOfCall('Bash', { command: '/tree/plugin/bin/thimble-run card 69d6b48a' }, 'card:69d6b48a\n...')).toEqual(['69d6b48a'])
  expect(cardsOfCall('Bash', { command: 'ls -la' }, '')).toEqual([])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__read_ref', {}, 'card:69d6b48a')).toEqual([])
})

test("main's end token is never shown", () => {
  expect(withoutEnd('(shown in the dashboard)')).toBe('')
  expect(withoutEnd('Done. **(shown in the dashboard).**')).toBe('Done.')
  expect(withoutEnd('The dashboard shows it.')).toBe('The dashboard shows it.')
})

test('the thimble command beside the plugin, the session mode, what a run printed, what changed', () => {
  expect(cliOf('/home/a/.thimble/app/mods/thimble-term', undefined)).toBe('/home/a/.thimble/app/plugin/bin/thimble')
  expect(cliOf('/repo/mods/thimble-term/.claude-plugin', undefined)).toBe('/repo/plugin/bin/thimble')
  expect(cliOf('/repo/mods/thimble-term', '/x/fake')).toBe('/x/fake')
  expect(launchMode('{"mode": "terminal"}')).toBe('terminal')
  expect(launchMode('{"session": "s"}')).toBe('')
  expect(launchMode('not json')).toBe('')
  expect(parsePrinted({ exitCode: 0, stdout: '{"a":1}', stderr: '' })).toEqual({ ok: true, value: { a: 1 } })
  expect(parsePrinted({ exitCode: 1, stdout: '{"error":"no workspace for /x"}', stderr: '' })).toEqual({ ok: false, error: 'no workspace for /x' })
  expect(parsePrinted({ exitCode: 2, stdout: '', stderr: 'Traceback\nValueError: bad' })).toEqual({ ok: false, error: 'ValueError: bad' })
  const a = { cards: '1', labels: '', docs: '', chats: '', agents: '', ui: '' }
  expect(changed(null, a).length).toBe(6)
  expect(changed(a, { ...a, cards: '2' })).toEqual(['cards'])
})
