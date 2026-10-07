// What thimble-term reads from `thimble state` (hooks/model.ts, hooks/data.ts): a citation's check, a thread's chat as
// turns, the lists, the cards a call of main's names, main's end token, the command and the scope.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { changed, cliOf, launchMode, parsePrinted } from '../hooks/data'
import { citations } from '../hooks/lib'
import { labelCard } from '../hooks/cell'
import { agentsOf, cardsOfCall, cellsOf, docsOf, homeOf, labelIdOf, labelOf, labelsOf, namedForks, namedThreads, resolutionOf, runShown, threadOf, threadRowsOf, verdictOf, withoutEnd, withoutToldThreads } from '../hooks/model'
import { turnTimes, wrapRows } from '../hooks/draw'
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
  expect(t.turns).toEqual([{ q: 'why is events.jsonl so much bigger?', a: 'It holds [[19913|card:a0frame0#records/events.jsonl]] rows, one per event.', state: 'done', tools: 1, partial: 'It holds [[19913|card:a0frame0#records/events.jsonl]] rows, one per event.', cards: [] }])
  expect(t.label).toBe('What does the export hold per wiki?')
  expect(t.parent).toBe('')
  const failed = threadOf({ id: 'x' }, [{ type: 'user', text: 'q' }, { type: 'error', error: 'stopped by the analyst' }])
  expect(failed.turns[0]).toMatchObject({ state: 'error', a: 'stopped by the analyst' })
  // main's reply_in_thread is an answer though no `done` follows it (terminal mode)
  const replied = threadOf({ id: 'y' }, [{ type: 'user', text: 'Is 2994 all of them?' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', delta: 'Yes, for this file.', reply: true }, { type: 'user', text: 'And dorfwiki?' }])
  expect(replied.turns.map(t => t.state)).toEqual(['done', 'running'])
  expect(replied.turns[0]!.a).toBe('Yes, for this file.')
  // a reply after the end that said main's turn ended unanswered: the reply is the answer, the end's words are gone
  const late = threadOf({ id: 'z' }, [{ type: 'user', text: 'Is 2994 all of them?' }, { type: 'error', message: "Main's turn ended without answering in this thread", kind: 'unanswered' }, { type: 'text', delta: "Yes, I'm sure.", reply: true }])
  expect(late.turns[0]).toMatchObject({ state: 'done', a: "Yes, I'm sure." })
})

test("a thread's answer is its first reply: the fork's working words after it are left out, and texts a tool call parts are two paragraphs; the cards it made are its turn's", () => {
  // the live check's thread (New 4): the answer, a tool call, then a note as the fork made its card, both marked reply
  const t = threadOf({ id: 'f' }, [
    { type: 'user', text: 'Is the 3,898 deletions figure supported anywhere in the event log?' },
    { type: 'tool_use', name: 'Bash' },
    { type: 'tool_result', summary: 'Exit code 1' },
    { type: 'text', delta: 'No. The event log has 2 deletions in total. But no file in the corpus records any.', reply: true, by: 'terminal' },
    { type: 'tool_use', name: 'Bash' },
    { type: 'text', delta: 'Incidental (a page body length). Making the card.', reply: true, by: 'terminal' },
    { type: 'tool_use', name: 'mcp__plugin_thimble_thimble__add_card' },
    { type: 'tool_result', summary: '$ add_card …', cell_id: '9b0f8b3b' },
    { type: 'tool_use', name: 'mcp__plugin_thimble_thimble__edit_card' },
    { type: 'tool_result', summary: '$ edit_card …', cell_id: '9b0f8b3b' },
  ])
  expect(t.turns[0]!.a).toBe('No. The event log has 2 deletions in total. But no file in the corpus records any.')
  expect(t.turns[0]!.a).not.toContain('Making the card')
  expect(t.turns[0]!.state).toBe('done')
  expect(t.turns[0]!.cards).toEqual(['9b0f8b3b'])
  // streamed words a tool call parts, before any reply: two paragraphs, never `any.Incidental`
  const streamed = threadOf({ id: 's' }, [{ type: 'user', text: 'q' }, { type: 'text', delta: 'First part.' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', delta: 'Second part.' }, { type: 'done', result: '' }])
  expect(streamed.turns[0]!.a).toBe('First part.\n\nSecond part.')
  // deltas of one message still join as written
  const deltas = threadOf({ id: 'd' }, [{ type: 'user', text: 'q' }, { type: 'text', delta: 'One ' }, { type: 'text', delta: 'message.' }, { type: 'done', result: '' }])
  expect(deltas.turns[0]!.a).toBe('One message.')
})

test("main's own `↳ thread` line is left out for a thread whose row thimble-term drew; a fork and its notice name the thread by its question", () => {
  const rows = [
    { id: 't1', title: 'agent-chat:2', fork: 'agent-chat-2', question: 'Is the 3,898 deletions figure supported anywhere in the event log?' },
    { id: 't2', title: '2,994', fork: '2-994', question: 'How many of the 2,994 dse revisions were made on 18 June?' },
  ]
  const told = new Set(['t2'])
  // by its slug, as main writes it, and by its question in quotation marks; another thread's line stays
  expect(withoutToldThreads('↳ thread 2-994: answered that 1,422 of them were.', rows, told)).toBe('')
  expect(withoutToldThreads('↳ thread "How many of the 2,994 dse revisions…": answered.', rows, told)).toBe('')
  expect(withoutToldThreads('↳ thread agent-chat-2: answered that nothing supports it.', rows, told)).toBe('↳ thread agent-chat-2: answered that nothing supports it.')
  expect(withoutToldThreads('The card is above.\n\n↳ thread 2-994: answered.\n\nMore.', rows, told)).toBe('The card is above.\n\nMore.')
  expect(withoutToldThreads('↳ thread 2-994: answered.', rows, new Set())).toBe('↳ thread 2-994: answered.')
  // the Agent call's description and the notice that its fork finished
  expect(namedForks('thread:agent-chat-2', rows)).toBe('thread "Is the 3,898 deletions figure supported…"')
  expect(namedForks('Agent "thread:2-994" finished', rows)).toBe('Agent thread "How many of the 2,994 dse revisions…" finished')
  expect(namedForks('thread:unknown-one', rows)).toBe('thread:unknown-one')
  expect(namedForks('writer: report', rows)).toBe('writer: report')
})

test("main's `↳ thread <slug>:` line names the thread by its first question", () => {
  const rows = [{ id: 't1', title: 'nearly-all-revisions-are', fork: 'nearly-all-revisions-are', question: 'Is 2994 all of the [[dse|card:a#x/y]] revisions in this file, and how sure is it?' }]
  expect(namedThreads('↳ thread nearly-all-revisions-are: confirmed 2994 is every dse record.', rows)).toBe('↳ thread "Is 2994 all of the dse revisions in…": confirmed 2994 is every dse record.')
  expect(namedThreads('↳ thread other-one: done.', rows)).toBe('↳ thread other-one: done.')
  expect(namedThreads('No thread here.', rows)).toBe('No thread here.')
})

test("a turn's words in up to three rows, the last cut; a transcript's times as the clock, the day where it changes", () => {
  expect(wrapRows('one two three', 20, 3)).toEqual(['one two three'])
  const rows = wrapRows('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu', 12, 3)
  expect(rows.length).toBe(3)
  expect(rows.slice(0, 2)).toEqual(['alpha beta', 'gamma delta'])
  expect(rows[2]).toBe('epsilon…')
  expect(rows.every(r => r.length <= 12)).toBe(true)
  expect(wrapRows('x'.repeat(30), 12, 3)).toEqual(['x'.repeat(12), 'x'.repeat(12), 'x'.repeat(6)])
  expect(wrapRows('x'.repeat(40), 12, 3)).toEqual(['x'.repeat(12), 'x'.repeat(12), `${'x'.repeat(11)}…`])
  expect(turnTimes(['2026-06-18T07:40:01Z', '2026-06-18T07:41:00Z', '2026-06-19T09:00:00Z'])).toEqual([
    { clock: '07:40:01', day: '18 Jun 2026' },
    { clock: '07:41:00', day: '' },
    { clock: '09:00:00', day: '19 Jun 2026' },
  ])
  expect(turnTimes(['10:00', '10:01'])).toEqual([{ clock: '10:00', day: '' }, { clock: '10:01', day: '' }])
  expect(turnTimes(['2026-06-18T07:40:00Z', ''])).toEqual([{ clock: '07:40', day: '18 Jun 2026' }, { clock: '', day: '' }])
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
  expect(docsOf(STATES.docs)).toEqual([{ slug: 'report', title: 'Agents used the dse wiki as a relay', renderer: 'document', status: 'written', generation: 0, at: '' }])
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
  // several cards run again in a shell loop: each card its output names
  const loop = 'B=/mnt/store/x/plugin/bin/thimble-run; for c in 2d10d7f3 9b4bb0cb; do $B card $c; done'
  expect(cardsOfCall('Bash', { command: loop }, 'card:2d10d7f3\n[out0: plot]\n\ncard:9b4bb0cb\n[out0: table]\n')).toEqual(['2d10d7f3', '9b4bb0cb'])
  // its row: each card by its question, never the install path or an id; cards not read yet are counted
  const q = (id: string) => ({ '2d10d7f3': 'How many revisions does each wiki have?', '9b4bb0cb': 'Which ten pages have the most revisions?' })[id]
  expect(runShown(loop, q)).toBe('thimble-run card "How many revisions does each wiki have?", "Which ten pages have the most revisions?"')
  expect(runShown(loop, () => undefined)).toBe('thimble-run card · 2 cards')
  expect(runShown('/tree/plugin/bin/thimble-run card 2d10d7f3', q)).toBe('thimble-run card "How many revisions does each wiki have?"')
  expect(runShown('/tree/plugin/bin/thimble-run stale', q)).toBe('thimble-run stale')
  // a long question cut at a word, its comma left out, never mid-word (live check New 9)
  const long = (id: string) => (id === '2d10d7f3' ? 'What are the main events in the corpus, in order?' : 'Which five pages have the most revisions in the corpus?')
  expect(runShown(loop, long)).toBe('thimble-run card "What are the main events in the corpus…", "Which five pages have the most…"')
  expect(runShown('B="/x/plugin/bin/thimble-run"; for c in 2d10d7f3 9b4bb0cb; do "$B" card "$c"; done', () => undefined)).toBe('thimble-run card · 2 cards')
  for (const shown of [runShown(loop, q), runShown(loop, () => undefined)]) expect(shown).not.toMatch(/\/mnt|[0-9a-f]{8}/)
  // output naming cards from a command that runs no thimble-run is no card of the turn
  expect(cardsOfCall('Bash', { command: 'grep card notes.txt' }, 'card:2d10d7f3')).toEqual([])
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
  const a = { cards: '1', labels: '', docs: '', chats: '', agents: '', views: '', ui: '' }
  expect(changed(null, a).length).toBe(7)
  expect(changed(a, { ...a, cards: '2' })).toEqual(['cards'])
})

test("a label's counts as the concept routes give them, beside its fields, reach its card and the labels list", () => {
  // the shape of GET /concepts/<id> and of `thimble state label` (concepts.with_stats): counts and n_labeled at the top
  const route = {
    id: 'k1', name: 'author a', kind: 'regex', unit: 'record', labels: ['yes', 'no'], counts: { yes: 2, no: 1 }, n_labeled: 3,
    applications: [{ total: 3, labeled: 3, status: 'done', paths: ['posts.jsonl'] }],
    rows: [{ ref: 'posts.jsonl#L2', label: 'no', analyst: 'yes', text: 'world peace', rationale: '' }],
  }
  const label = labelOf(route)!
  expect(label.label_stats).toEqual({ counts: { yes: 2, no: 1 }, n_labeled: 3 })
  const card = labelCard({ id: 'c1', kind: 'label', title: 'author a', payload: { concept: 'k1' } } as never, label)
  expect((card.rows as { label: string; value: number }[]).map(r => [r.label, r.value])).toEqual([['yes', 2], ['no', 1]])
  expect(card.examples![0]).toMatchObject({ ref: 'posts.jsonl#L2', value: 'yes', set: true, was: 'no' })
  expect(labelsOf([route])[0]!.label_stats?.counts).toEqual({ yes: 2, no: 1 })
  // a label that already carries label_stats (the stored file's field) keeps them
  expect(labelOf({ id: 'k2', label_stats: { counts: { a: 1 } }, counts: { a: 9 } })!.label_stats).toEqual({ counts: { a: 1 } })
})
