// What thimble-term reads from `thimble state` (hooks/model.ts, hooks/data.ts): a citation's check against its place (a
// clock time a value), the cards a call of main's names, the `thimble` command beside the plugin, a label's counts as
// the routes give them; and where a reply's cited cards stand (lib.ts cardsInline). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { changed, cliOf, parsePrinted } from '../data'
import { cardsInline, citations, valueIn } from '../lib'
import { showsValue } from '../cite'
import { labelCard } from '../cell'
import { cardsOfCall, labelOf, labelsOf, resolutionOf, runShown, verdictOf } from '../model'
import { RESOLVE } from './fixtures'

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

test('the cards a call of main names: add_card, edit_card, apply_label, and a card run in Bash', () => {
  const add = 'mcp__plugin_thimble_thimble__add_card'
  expect(cardsOfCall(add, { question: 'q' }, 'card:8c2264f4, your last card, still has no takeaway.\n\ncard:69d6b48a\n[out0: ...]')).toEqual(['69d6b48a'])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__edit_card', { card: 'card:8c2264f4' }, 'takeaway noted')).toEqual(['8c2264f4'])
  // the result's first line echoes the call cut short: a card id cut there is no card (live QA on 0.7.0: `× card 2
  // cannot be drawn` under the reply, for `card:e157e5…`)
  const echo = '$ edit_card card="e157e542" takeaway="One day stands out. On Jun 18 the dse wiki got [[5,884|card:e157e5\u2026"\ntakeaway noted on card:e157e542 (linked 5,884)'
  expect(cardsOfCall('mcp__plugin_thimble_thimble__edit_card', { card: 'e157e542', takeaway: 'x' }, echo)).toEqual(['e157e542'])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__edit_card', {}, echo)).toEqual(['e157e542'])
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
  // a card named by its question (`card:prs-merged-week`), in a loop beside an older card's random id
  const named = (id: string) => ({ 'prs-merged-week': 'How many PRs merged per week?', '9b4bb0cb': 'Which ten pages have the most revisions?' })[id]
  expect(runShown('/tree/plugin/bin/thimble-run card prs-merged-week', named)).toBe('thimble-run card "How many PRs merged per week?"')
  expect(runShown('B=/x/thimble-run; for c in prs-merged-week 9b4bb0cb; do $B card "$c"; done', named)).toBe('thimble-run card "How many PRs merged per week?", "Which ten pages have the most revisions?"')
  // output naming cards from a command that runs no thimble-run is no card of the turn
  expect(cardsOfCall('Bash', { command: 'grep card notes.txt' }, 'card:2d10d7f3')).toEqual([])
  expect(cardsOfCall('mcp__plugin_thimble_thimble__read_ref', {}, 'card:69d6b48a')).toEqual([])
})

test('the thimble command beside the plugin, what a run printed, what changed', () => {
  expect(cliOf('/home/a/.thimble/app/plugin', undefined)).toBe('/home/a/.thimble/app/plugin/bin/thimble')
  expect(cliOf('/repo/plugin/.claude-plugin', undefined)).toBe('/repo/plugin/bin/thimble')
  expect(cliOf('/repo/plugin', '/x/fake')).toBe('/x/fake')
  expect(parsePrinted({ exitCode: 0, stdout: '{"a":1}', stderr: '' })).toEqual({ ok: true, value: { a: 1 } })
  expect(parsePrinted({ exitCode: 1, stdout: '{"error":"no workspace for /x"}', stderr: '' })).toEqual({ ok: false, error: 'no workspace for /x' })
  expect(parsePrinted({ exitCode: 2, stdout: '', stderr: 'Traceback\nValueError: bad' })).toEqual({ ok: false, error: 'ValueError: bad' })
  const a = { cards: '1', labels: '', docs: '', chats: '', agents: '', views: '', ui: '', coverage: '', answers: '' }
  expect(changed(null, a).length).toBe(9)
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

test("a clock time is a value a citation shows: found where the line writes that time, red where it writes another (MATT-NOTES \"Mockup feedback\")", () => {
  // `14:52:11` read "its value is not checked, and a script got the same number" in its tip and "only its place is
  // checked" in its panel: a time is a value, checked at its place as a number is
  const line = '{"id": 197, "ts": "2026-08-30T14:52:11.325+00:00", "agent": "agent-07", "action": "git.ref"}'
  for (const d of ['14:52', '14:52:11', '14:52:11.325', '09:38 UTC']) expect(showsValue(d)).toBe(true)
  for (const d of ['14:52', '14:52:11', '14:52:11.325']) expect(valueIn(d, line)).toBe(true)
  // the same hour and minute, the same second when the time gives one; never a time inside another
  for (const d of ['14:58', '14:52:12', '4:52']) expect(valueIn(d, line)).toBe(false)
  expect(valueIn('09:38', 'at 9:38:00 the run began')).toBe(true)
  const res = { ref: 'events.jsonl#L197', kind: 'record', path: 'events.jsonl', line: 197, blocks: [{ text: line }], excerpt: line }
  const ok = verdictOf(citations('[[14:52|events.jsonl#L197]]')[0]!, res as never)
  expect(ok).toMatchObject({ status: 'ok', why: 'the value is at its place' })
  // the time marked where the line writes it
  expect(ok.lines.find(l => l.hit)?.spans).toEqual([[line.indexOf('14:52'), line.indexOf('14:52') + 5]])
  expect(verdictOf(citations('[[14:58|events.jsonl#L197]]')[0]!, res as never).status).toBe('differs')
})

test('a card cited by a chip alone stands after the paragraph that cites it, its chip taken out of the sentence', () => {
  const md = 'Yes. The transcripts are under 1 MB [[card:a1b2c3d4]].\nThe logs are the rest.\n\nThat is all.'
  expect(cardsInline(md)).toBe('Yes. The transcripts are under 1 MB.\nThe logs are the rest.\n\n[[card:a1b2c3d4]]\n\nThat is all.')
})
