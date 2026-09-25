// The pointing gesture's pure side (src/pointer/anchors.ts: the range math, the word under a caret, the line pieces, the
// text-vs-element decision; pointer/cursor.ts: the pointer cursors; pointer/capture.ts: the element a point names;
// pointer/PointerBox.tsx and highlight.ts: where the ask box and the region go; pointer/parts.ts: a card's line, a
// chart's mark and its edge band) and the chat's pure helpers around it
// (chat/chips.ts, chat/threads.ts, components/ThreadTree.tsx, chat/ChatPanel.tsx, chat/StartGate.tsx,
// chat/ModelLine.tsx). The range gathering and the text hit test in a laid-out page are
// tests/public/browser/pointer-page.test.ts.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import * as anchors from '../../src/pointer/anchors.ts'
import { fieldValue, lineAt, markText, nearEdge } from '../../src/pointer/parts.ts'
import * as chips from '../../src/chat/chips.ts'
import { pickItems, threadNodes, startedByThimble, orientBuild, ticketSlug, threadKind, threadLabels, writerDoc, stepName, checkLabel } from '../../src/chat/threads.ts'
import { cleanName, treeRows, filterRows, attention, activeCount, FILTER_MIN, ancestorsOf, hiddenState } from '../../src/components/ThreadTree.tsx'
import { threadAnchors, ticketRequest, ticketAsk, withTicketShots, orientMessages, taskStrip, subagentCount, stepProgress, canAskAgain, viewBuildParts, buildStage, buildStatus, firstSentence } from '../../src/chat/ChatPanel.tsx'
import { foldRecords, toolSummary } from '../../src/chat/model.ts'
import { inputRows, ticketChipText } from '../../src/chat/Rows.tsx'
import { ticketStatusText } from '../../src/chat/TicketStatus.tsx'
import { boxPlace, MARGIN, GAP_UNDER, GAP_BESIDE, BESIDE_DROP, BOX_WIDTH } from '../../src/pointer/PointerBox.tsx'
import { regionShape, MIN_RADIUS, REGION_PAD } from '../../src/pointer/highlight.ts'
import { cursorValue, cmdCursors } from '../../src/pointer/cursor.ts'
import { selectorPath, stableClassOf, describe, PATH_LEVELS } from '../../src/pointer/capture.ts'
import { refLabel } from '../../src/lib/refs.ts'
import { togglePass, chosenPasses, ALL_ON, PASSES, startGateOpen, startBody, permissionChoice, PERMISSION_OPTIONS, BYPASS_WARNING } from '../../src/chat/StartGate.tsx'
import { EFFORT_CHOICES, effortWord, mainEffort, ORIENT_DEFAULT_EFFORT, mainFast } from '../../src/chat/ModelLine.tsx'

// the modules under test as one loosely typed namespace: the cases hand them partial records, as the chat folds them
const m: Record<string, any> = {
  ...anchors,
  ...chips,
  pickItems, threadNodes, startedByThimble, orientBuild, ticketSlug, threadKind, threadLabels, writerDoc, stepName, checkLabel,
  cleanName, treeRows, filterRows, attention, activeCount, FILTER_MIN, ancestorsOf, hiddenState,
  threadAnchors, ticketRequest, ticketAsk, withTicketShots, orientMessages, taskStrip, subagentCount, stepProgress, canAskAgain, viewBuildParts, buildStage, buildStatus, firstSentence,
  foldRecords, toolSummary, inputRows, ticketChipText, ticketStatusText,
  boxPlace, MARGIN, GAP_UNDER, GAP_BESIDE, BESIDE_DROP, BOX_WIDTH, regionShape, MIN_RADIUS, REGION_PAD,
  cursorValue, cmdCursors, selectorPath, stableClassOf, describe, PATH_LEVELS, refLabel,
  togglePass, chosenPasses, ALL_ON, PASSES, startGateOpen, startBody, permissionChoice, PERMISSION_OPTIONS, BYPASS_WARNING,
  EFFORT_CHOICES, effortWord, mainEffort, ORIENT_DEFAULT_EFFORT, mainFast,
}

const el = (anchor: string, text: string) => ({ el: null, anchor, text })

test('isDrag: a press that moved under the threshold is a click', () => {
  assert.equal(m.isDrag({ x: 10, y: 10 }, { x: 12, y: 13 }), false)
  assert.equal(m.isDrag({ x: 10, y: 10 }, { x: 15, y: 10 }), true)
  assert.equal(m.isDrag({ x: 10, y: 10 }, { x: 10, y: 4 }), true)
  assert.equal(m.isDrag({ x: 0, y: 0 }, { x: 2, y: 0 }, 2), true, 'the threshold is a parameter')
})

test('joinAnchors and dedupeAnchors: covered refs joined by a comma, each once', () => {
  const anchors = [el('cell:a1', 'A'), el('cell:b2', 'B'), el('cell:a1', 'A again'), el('report:report#s3', 'S')]
  assert.equal(m.joinAnchors(anchors), 'cell:a1,cell:b2,cell:a1,report:report#s3')
  const d = m.dedupeAnchors(anchors)
  assert.deepEqual(
    d.map((a: any) => a.anchor),
    ['cell:a1', 'cell:b2', 'report:report#s3'],
  )
  assert.equal(m.joinAnchors(d), 'cell:a1,cell:b2,report:report#s3')
})

test('rangeContext: the selected text wins, the elements text stands in, both cut to ANCHOR_TEXT_MAX', () => {
  const anchors = [el('cell:a1', 'How many agents?'), el('cell:b2', 'Lines per file')]
  assert.equal(m.rangeContext(anchors, '  many   agents?\n\nLines '), 'many agents?\nLines', 'blank lines squeeze to one break')
  assert.equal(m.rangeContext(anchors, '   '), 'How many agents?\nLines per file')
  assert.equal(m.rangeContext(anchors, 'x'.repeat(m.ANCHOR_TEXT_MAX + 50)).length, m.ANCHOR_TEXT_MAX)
  assert.equal(m.joinAnchorText([el('cell:a1', 'y'.repeat(m.ANCHOR_TEXT_MAX)), el('cell:b2', 'z')]).length, m.ANCHOR_TEXT_MAX)
})

test('wordAt: the run around the caret, punctuation trimmed; white space and bare punctuation are no word', () => {
  const t = 'the changelog.jsonl, file (Staff1) — wiki'
  assert.deepEqual(m.wordAt(t, 0), { start: 0, end: 3, word: 'the' })
  assert.deepEqual(m.wordAt(t, 3), { start: 0, end: 3, word: 'the' }, 'a caret at the end of a run belongs to it')
  assert.equal(m.wordAt(t, 4).word, 'changelog.jsonl', 'the dot inside a name stays, the comma after it goes')
  assert.equal(m.wordAt(t, 19).word, 'changelog.jsonl', 'a caret on the trailing comma still names the word')
  assert.equal(m.wordAt(t, 27).word, 'Staff1', 'the parentheses are trimmed')
  assert.equal(m.wordAt(t, 35), null, 'a dash alone is no word')
  assert.equal(m.wordAt('a  b', 2), null, 'a caret in white space between runs is no word')
  assert.equal(m.wordAt('', 0), null)
  assert.equal(m.wordAt(t, 999).word, 'wiki', 'an offset past the end clamps to the last run')
})

test('mergeLineRects: rects on one line join, lines stay apart, empty rects drop, top to bottom', () => {
  const r = (left: any, top: any, right: any, bottom: any) => ({ left, top, right, bottom })
  const pieces = m.mergeLineRects([r(40, 120, 60, 136), r(10, 100, 50, 116), r(0, 0, 0, 16), r(50, 101, 90, 117), r(10, 120, 40, 136)])
  assert.deepEqual(pieces, [r(10, 100, 90, 117), r(10, 120, 60, 136)])
  assert.deepEqual(m.mergeLineRects([]), [])
  // a superscript's rect overlaps its line by more than half its own height and joins it
  assert.equal(m.mergeLineRects([r(0, 100, 10, 116), r(10, 96, 14, 106)]).length, 1)
  assert.deepEqual(m.unionBox([r(10, 100, 90, 117), r(10, 120, 60, 136)]), r(10, 100, 90, 136))
})

test('isTextHit: a word outside a control whose glyphs hold the point, within TEXT_SLACK', () => {
  const rects = [{ left: 100, top: 200, right: 140, bottom: 216 }]
  assert.equal(m.isTextHit({ inControl: false, word: 'wiki', rects }, 120, 208), true)
  assert.equal(m.isTextHit({ inControl: false, word: 'wiki', rects }, 141, 217), true, 'the slack beside a glyph counts')
  assert.equal(m.isTextHit({ inControl: false, word: 'wiki', rects }, 150, 208), false, 'the margin beside the line is not the word')
  assert.equal(m.isTextHit({ inControl: true, word: 'Run', rects }, 120, 208), false, 'a control stays a region')
  assert.equal(m.isTextHit({ inControl: false, word: null, rects: [] }, 120, 208), false)
  assert.equal(m.boxContains(rects[0], 100, 200), true)
  assert.ok(m.CONTROL_SELECTOR.includes('button') && m.CONTROL_SELECTOR.includes('.chip') && m.CONTROL_SELECTOR.includes('.switch'))
})

test('chips: pending statuses, and the stream event that settles a ref', () => {
  assert.equal(m.chipPending('generating'), true)
  assert.equal(m.chipPending('proposed'), false)
  assert.equal(m.chipPending('queued'), true, 'a view ticket waiting for room in the pool')
  assert.equal(m.chipPending('building'), true)
  assert.equal(m.chipPending('done'), false)
  assert.equal(m.chipPending(undefined), false)
  assert.equal(m.settleChip('report:report', { type: 'report', slug: 'report', status: 'generated' }), 'done')
  assert.equal(m.settleChip('report:report', { type: 'report', slug: 'report', status: 'generating' }), null)
  assert.equal(m.settleChip('report:report', { type: 'report', slug: 'report', status: 'failed' }), 'failed')
  assert.equal(m.settleChip('report:report', { type: 'report', slug: 'story', status: 'generated' }), null, 'another document')
  assert.equal(m.settleChip('view:tool-graph', { type: 'view', slug: 'tool-graph', status: 'built' }), 'done')
  assert.equal(m.settleChip('view:tool-graph', { type: 'view', slug: 'tool-graph', status: 'building' }), null)
  assert.equal(m.settleChip('view:tool-graph', { type: 'report', slug: 'tool-graph', status: 'generated' }), null, 'a report event never settles a view')
  assert.equal(m.settleChip(undefined, { type: 'view', slug: 'x', status: 'built' }), null)
  assert.equal(m.chipIcon('artifact'), 'canvas')
  assert.equal(m.chipIcon('nonsense'), 'flag')
  const rows = m.foldRecords([{ type: 'chip', kind: 'artifact', text: 'writing the report', ref: 'report:report', status: 'generating' }])
  assert.equal(rows[0].status, 'generating', 'the fold keeps the chip status')
})

test('the picker: main first and not renameable, threads carry their title', () => {
  const chats = [
    { id: 't2', kind: 'thread', title: 'second', created_at: '2026-09-22T11:00:00Z' },
    { id: 'main', kind: 'main', title: 'main', created_at: '2026-09-22T10:00:00Z' },
    { id: 't1', kind: 'thread', title: '', created_at: '2026-09-22T10:30:00Z' },
    { id: 'ag', kind: 'agent', title: 'orientation', created_at: '2026-09-22T10:10:00Z' },
  ]
  const items = m.pickItems(
    chats,
    () => false,
    () => false,
  )
  assert.deepEqual(
    items.map((i: any) => [i.id, i.label, i.title, i.isMain]),
    [
      ['main', 'main', '', true],
      ['t1', 'main/t1', 't1', false],
      ['t2', 'main/second', 'second', false],
    ],
  )
  assert.equal(m.cleanName('  a   new\nname ', 'old'), 'a new name')
  assert.equal(m.cleanName('   ', 'old'), 'old', 'an empty name keeps the old one')
})

// the open tree's rows as [id, depth]
const rowIds = (rows: any[]) => rows.map((r: any) => [r.node.id, r.depth])

test('the thread tree: every thread is listed, main first and the rows under each row most recent first', () => {
  const T = (h: any) => `2026-09-25T${String(h).padStart(2, '0')}:00:00Z`
  const item = (id: string, o: object = {}) => ({ id, label: id === 'main' ? 'main' : `main/${id}`, title: id === 'main' ? '' : id, isMain: id === 'main', kind: id === 'main' ? 'main' : 'thread', running: false, unread: false, done: false, parent: id === 'main' ? null : 'main', lastTs: T(1), ...o })
  const items = [
    item('main'),
    item('t1', { running: true, lastTs: T(1) }),
    item('t2', { lastTs: T(9) }),
    item('t3', { unread: true, lastTs: T(2) }),
    item('t4', { lastTs: T(8) }),
    item('t5', { lastTs: T(3), parent: 't1', label: 'main/t1/t5' }),
  ]
  const nodes = m.threadNodes(items)
  assert.deepEqual(nodes.map((n: any) => n.id), ['main', 't2', 't4', 't1', 't5', 't3'], 'a row counts the latest activity of the rows under it')
  assert.ok(nodes.every((n: any) => !('inactive' in n) && !('group' in n)), 'nothing folds away')
  assert.deepEqual(rowIds(m.treeRows(nodes)), [['main', 0], ['t2', 1], ['t4', 1], ['t1', 1], ['t5', 2], ['t3', 1]])
  // nesting: a thread asked from another hangs under it; one whose parent is not listed stands at the top level
  const rows = m.treeRows([
    { id: 'main', name: 'main', parent: null, fixed: true },
    { id: 'a', name: 'a', parent: 'main' },
    { id: 'orient', name: 'orient', parent: null },
    { id: 'b', name: 'b', parent: 'a' },
    { id: 'c', name: 'c', parent: 'gone' },
    { id: 'f', name: 'f', parent: 'orient' },
    { id: 'x', name: 'x', parent: 'y' },
    { id: 'y', name: 'y', parent: 'x' },
  ])
  assert.deepEqual(rowIds(rows), [['main', 0], ['a', 1], ['b', 2], ['orient', 0], ['f', 1], ['c', 0], ['x', 0], ['y', 1]], 'a cycle of parents is still listed')
  assert.deepEqual(rows.filter((r: any) => r.kids).map((r: any) => r.node.id), ['main', 'a', 'orient', 'x'], 'the rows with rows under them')
  // folding: the rows under a folded row are left out, at every depth, and a folded row tells what they hold
  const tree = [
    { id: 'main', name: 'main', parent: null, fixed: true },
    { id: 'a', name: 'a', parent: 'main' },
    { id: 'b', name: 'b', parent: 'a', unread: true },
    { id: 'c', name: 'c', parent: 'b', waiting: true },
    { id: 'd', name: 'd', parent: 'main', running: true },
  ]
  assert.deepEqual(rowIds(m.treeRows(tree, new Set(['a']))), [['main', 0], ['a', 1], ['d', 1]])
  assert.deepEqual(rowIds(m.treeRows(tree, new Set(['b']))), [['main', 0], ['a', 1], ['b', 2], ['d', 1]])
  assert.deepEqual(m.ancestorsOf(tree, 'c'), ['b', 'a', 'main'])
  assert.deepEqual(m.ancestorsOf(tree, 'main'), [])
  assert.deepEqual(m.hiddenState(tree, 'a', 'main'), { running: false, unread: true, waiting: true })
  assert.deepEqual(m.hiddenState(tree, 'a', 'b'), { running: false, unread: false, waiting: true }, 'the current thread is being read')
  assert.deepEqual(m.hiddenState(tree, 'main', 'main'), { running: true, unread: true, waiting: true })
  const att = m.attention([
    { id: 'main', name: 'main', parent: null, unread: true },
    { id: 'a', name: 'a', parent: 'main', running: true },
    { id: 'b', name: 'b', parent: 'main', unread: true },
    { id: 'c', name: 'c', parent: 'main', running: true, waiting: true },
  ], 'main')
  assert.deepEqual(att, { running: 2, unread: 1, waiting: 1 }, 'the current thread is being read')
  // the search: names and full names, each at the top level
  assert.deepEqual(m.filterRows(nodes, 'T5').map((r: any) => [r.node.id, r.depth]), [['t5', 0]])
  assert.deepEqual(m.filterRows(nodes, 'main/t').length, 5)
  assert.deepEqual(m.filterRows(nodes, '  '), [])
})

test('the tree: main and the latest orientation at the top level, every other session under main, a thread under the chat it was asked from', () => {
  const chats = [
    { id: 'main', kind: 'main', title: 'main', created_at: '2026-09-22T10:00:00Z' },
    { id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-22T10:01:00Z', status: 'done' },
    { id: 'o2', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-22T12:00:00Z', status: 'running' },
    { id: 'd1', kind: 'agent', role: 'dev', title: 'ticket #3: Group the Message board by round, newest first', created_at: '2026-09-22T11:00:00Z', status: 'running' },
    { id: 'w1', kind: 'agent', role: 'subagent', title: 'write report', created_at: '2026-09-22T11:30:00Z', status: 'running' },
    { id: 't1', kind: 'thread', title: 'why-the-spike', created_at: '2026-09-22T10:30:00Z', parent: 'main', anchor: 'cell:a1', n_messages: 2 },
    { id: 't2', kind: 'thread', title: 'the-summary', created_at: '2026-09-22T12:10:00Z', parent: 'o2', anchor: 'chat:o2#3', n_messages: 1 },
    { id: 't3', kind: 'thread', title: 'nested', created_at: '2026-09-22T12:20:00Z', parent: 't1', anchor: 'chat:t1#1', n_messages: 1 },
    { id: 't4', kind: 'thread', title: 'orphan', created_at: '2026-09-22T12:30:00Z', parent: 'gone', anchor: 'card:x', n_messages: 1 },
  ]
  const items = m.pickItems(chats, () => false, () => true)
  assert.deepEqual(
    items.map((i: any) => [i.id, i.label, i.title, i.kind, i.parent]),
    [
      ['main', 'main', '', 'main', null],
      ['o1', 'orient-1', 'orient-1', 'orient', 'main'],
      ['t1', 'main/why-the-spike', 'why-the-spike', 'thread', 'main'],
      ['t3', 'main/why-the-spike/nested', 'nested', 'thread', 't1'],
      ['d1', 'dev/group-the-message-board', 'group-the-message-board', 'dev', 'main'],
      ['t4', 'main/orphan', 'orphan', 'thread', 'main'],
      ['o2', 'orient', 'orient', 'orient', null],
      ['t2', 'orient/the-summary', 'the-summary', 'thread', 'o2'],
    ],
    'the older orientation and the ticket under main; the latest orientation at the top with its thread; a thread whose parent is gone under main; another subagent is no thread',
  )
  assert.equal(items.find((i: any) => i.id === 'o1').unread, false, 'an orientation reports in main, so its own chat is never unread')
  assert.equal(items.find((i: any) => i.id === 'o2').running, true, 'a running agent runs whatever the list route says')
  assert.equal(m.ticketSlug('ticket #12: Zoom percentage jitters while zooming'), 'zoom-percentage-jitters-while')
  assert.equal(m.ticketSlug(''), 'ticket')
  assert.equal(m.threadLabels(items).get('t2'), 'orient/the-summary')
  const nodes = m.threadNodes(items)
  assert.equal(nodes.find((n: any) => n.id === 't1').path, 'main/why-the-spike')
  assert.deepEqual(rowIds(m.treeRows(nodes)), [['main', 0], ['t4', 1], ['t1', 1], ['t3', 2], ['d1', 1], ['o1', 1], ['o2', 0], ['t2', 1]], 'the finished older orientation is listed under main, the most recent first')
  // a name the analyst gave a session takes the place of the last part of its name, and its threads follow it
  const named = m.threadLabels(m.pickItems(chats.map((c) => (c.id === 'd1' ? { ...c, name: 'board' } : c.id === 'o2' ? { ...c, name: 'first look' } : c)), () => false, () => false))
  assert.deepEqual([named.get('d1'), named.get('o2'), named.get('t2')], ['dev/board', 'first look', 'first look/the-summary'])
})

test('what the analyst did not start is left out of the list, and a thread with nothing in it is listed only while it is shown', () => {
  // the orientation's view builds are not listed, running or ended (its proposals repair themselves and one that
  // fails is dropped quietly); a check's run is listed while it runs
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-25T10:00:00Z', parent: null }
  const building = { ...main, id: 'v1', kind: 'agent', role: 'dev', view: 'run-clock', title: 'view: Run clock', created_at: '2026-09-25T10:01:00Z', parent: 'main', status: 'running' }
  const failed = { ...building, id: 'v2', view: 'agent-shift', title: 'view: Agent shift', status: 'failed' }
  const check = { ...main, id: 'k1', kind: 'agent', role: 'check', title: 'Unverified', created_at: '2026-09-25T10:02:00Z', parent: 'main', status: 'done' }
  const running = { ...check, id: 'k2', title: 'Verified', status: 'running' }
  const ticket = { ...main, id: 'd1', kind: 'agent', role: 'dev', ticket: 'x', title: 'ticket #1: Fix the zoom', created_at: '2026-09-25T10:03:00Z', parent: 'main', status: 'failed' }
  const empty = { ...main, id: 't1', kind: 'thread', role: 'thread', title: 'empty', created_at: '2026-09-25T10:04:00Z', parent: 'main', anchor: 'card:a', n_messages: 0 }
  const asked = { ...empty, id: 't2', title: 'asked', n_messages: 1 }
  const nested = { ...empty, id: 't3', title: 'nested', parent: 'v2', anchor: 'chat:v2#2', n_messages: 1 }
  assert.equal(m.startedByThimble(building), true)
  assert.equal(m.startedByThimble(check), true)
  assert.equal(m.startedByThimble(ticket), false)
  const chats = [main, building, failed, check, running, ticket, empty, asked, nested]
  const items = m.pickItems(chats, () => false, () => false)
  assert.deepEqual(items.filter((i: any) => i.hidden).map((i: any) => i.id), ['v1', 'k1', 't1'], 'a build that holds a thread of the analyst\'s is listed')
  assert.equal(items.find((i: any) => i.id === 'v1').label, 'dev/view-run-clock', 'a view build is named as a dev ticket is')
  const nodes = m.threadNodes(items)
  assert.deepEqual(nodes.map((n: any) => [n.id, n.parent]), [
    ['main', null],
    ['v2', 'main'],
    ['t3', 'v2'],
    ['t2', 'main'],
    ['d1', 'main'],
    ['k2', 'main'],
  ], 'the running check under main; the failed ticket (the analyst\'s) with its ✕; a thread asked from a build hangs under it')
  assert.equal(nodes.find((n: any) => n.id === 'd1').ended, 'failed')
  const shown = m.threadNodes(m.pickItems(chats, () => false, () => false, { current: 'k1' }))
  assert.ok(shown.find((n: any) => n.id === 'k1'), 'a finished check run opened from its pane is listed while it is shown')
  const opened = m.pickItems(chats, () => false, () => false, { current: 'v1' })
  assert.equal(opened.find((i: any) => i.id === 'v1').hidden, false, 'a build opened from its view\'s chip is listed while it is read')
  const waiting = m.pickItems(chats, () => false, () => false, { waiting: new Set(['t2', 'v1']) })
  assert.equal(waiting.find((i: any) => i.id === 't2').waiting, true)
  assert.equal(waiting.find((i: any) => i.id === 'v1').hidden, false, 'a build that waits for the analyst is listed')
})

test('a view the analyst asked for is built in a dev thread of main\'s, listed as a ticket is', () => {
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-25T10:00:00Z', parent: null }
  const mine = { ...main, id: 'a1', kind: 'agent', role: 'dev', view: 'page-timeline', asked: true, title: 'view: Page timeline', created_at: '2026-09-25T10:01:00Z', parent: 'main', status: 'running' }
  const theirs = { ...mine, id: 'v1', view: 'thread-board', asked: undefined, title: 'view: Thread board' }
  assert.equal(m.startedByThimble(mine), false)
  assert.equal(m.orientBuild(theirs), true)
  const items = m.pickItems([main, mine, theirs], () => false, () => false)
  const a1 = items.find((i: any) => i.id === 'a1')
  assert.equal(a1.hidden, false)
  assert.equal(a1.label, 'dev/view-page-timeline')
  assert.equal(a1.parent, 'main')
  assert.deepEqual(m.threadNodes(items).map((n: any) => n.id), ['main', 'a1'])
  const built = m.pickItems([main, { ...mine, status: 'done', ts_end: '2026-09-25T10:09:00Z' }], () => false, () => false)
  const node = m.threadNodes(built).find((n: any) => n.id === 'a1')
  assert.equal(node.ended, 'done', 'once built it stays listed with its check')
})

test('a thread asked about a built view hangs under the view\'s dev thread', () => {
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-25T10:00:00Z', parent: null }
  const build = { ...main, id: 'a1', kind: 'agent', role: 'dev', view: 'timeline', asked: true, title: 'view: Timeline', created_at: '2026-09-25T10:01:00Z', parent: 'main', status: 'done', ts_end: '2026-09-25T10:09:00Z' }
  const ask = { ...main, id: 't1', kind: 'thread', role: 'thread', title: 'i-can-t-scrub', created_at: '2026-09-25T10:10:00Z', parent: 'a1', anchor: 'view:timeline', n_messages: 1 }
  const other = { ...ask, id: 't2', title: 'why-the-spike', parent: 'main', anchor: 'card:x' }
  const items = m.pickItems([main, build, ask, other], () => false, () => false)
  assert.equal(items.find((i: any) => i.id === 't1').label, 'dev/view-timeline/i-can-t-scrub')
  const nodes = m.threadNodes(items)
  assert.deepEqual(nodes.map((n: any) => [n.id, n.parent]), [
    ['main', null],
    ['a1', 'main'],
    ['t1', 'a1'],
    ['t2', 'main'],
  ])
  assert.deepEqual(m.treeRows(nodes).map((r: any) => [r.node?.id, r.depth]), [['main', 0], ['a1', 1], ['t1', 2], ['t2', 1]])
})

test('a view build\'s thread: one part per run, the stage lines behind one status line, the change said once', () => {
  const stage = (text: string) => `\n· ${text}\n`
  const records = [
    { type: 'text', delta: stage('the session writes the view') },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', delta: 'Wrote the view.' , by: 'dev' },
    { type: 'text', delta: stage('checks failed: the page did not load') },
    { type: 'text', delta: stage('the session fixes what the checks found (attempt 2 of 3)') },
    { type: 'text', delta: stage('checks passed: 18 ref(s), the page loaded') },
    { type: 'user', text: 'I can\'t scrub the timeline' },
    { type: 'text', delta: stage('the change asked for: I can\'t scrub the timeline') },
    { type: 'text', delta: stage('the session writes the view') },
    { type: 'text', delta: stage('checks passed: 1 ref(s), the page loaded') },
    { type: 'text', delta: stage('the change asked for: Label the bars The bars need their day') },
    { type: 'text', delta: stage('the session writes the view') },
  ]
  const parts = m.viewBuildParts(m.foldRecords(records))
  assert.equal(parts.length, 3)
  assert.deepEqual(parts.map((p: any) => p.rows.map((r: any) => r.kind)), [['tool', 'text'], ['user'], []])
  assert.deepEqual(parts.map((p: any) => p.request), [null, null, 'Label the bars The bars need their day'], 'the line of a change asked through main is its request; the analyst\'s own message is not said again')
  assert.ok(parts.every((p: any) => p.rows.every((r: any) => r.kind !== 'note')), 'no stage line is left as a note')
  assert.deepEqual(m.buildStatus(parts[0].stages, false), { label: 'Checks passed', state: 'done', tip: 'Writing the view\nChecks failed: the page did not load\nFixing what the checks found · attempt 2 of 3\nChecks passed: 18 refs, the page loaded' })
  assert.equal(m.buildStatus(parts[1].stages, false).tip.split('\n').pop(), 'Checks passed: 1 ref, the page loaded')
  assert.deepEqual(m.buildStatus(parts[2].stages, true), { label: 'Writing the view', state: 'running', tip: 'Writing the view' })
  assert.equal(m.buildStatus(parts[2].stages, false).state, 'skipped', 'a stage that never finished reads as stopped once the run is over')
  assert.equal(m.buildStatus([], true), null)
  const waited = m.viewBuildParts(m.foldRecords([{ type: 'text', delta: stage('Anthropic\'s API was overloaded, so the build waits 2 min and goes on') }]))
  assert.deepEqual(waited[0].rows.map((r: any) => r.kind), ['note'], 'a wait after an API error stays a row, for its error card')
  assert.equal(m.buildStage('the view did not pass, so a new session builds it again from what failed (repair 1 of 2)').label, 'Building again in a new session · repair 1 of 2')
  assert.equal(m.buildStage('something new').label, 'Something new')
  assert.equal(m.firstSentence('The corpus is one event log across three boards.\nAlmost half of all posts fall on March 2-4.'), 'The corpus is one event log across three boards.')
  assert.equal(m.firstSentence('One line with no stop'), 'One line with no stop')
})

test('a dev ticket\'s request is its body before the context block; the strip follows the thread that works', () => {
  assert.equal(m.ticketRequest({ title: 'Zoom jitters', body: 'Give the percentage tabular figures.\n\ntab: canvas\ntheme: light' }), 'Give the percentage tabular figures.')
  assert.equal(m.ticketRequest({ title: 'The card head is too crowded', body: 'The card head is too crowded\nthe chips fight\n---\ntab: canvas' }), 'The card head is too crowded\nthe chips fight')
  assert.equal(m.ticketRequest({ title: 'Only a title', body: '' }), 'Only a title')
  const rows = m.foldRecords([
    { type: 'user', text: 'first' },
    { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.jsonl' } },
    { type: 'tool_result', id: 'a', summary: 'ok' },
    { type: 'user', text: 'second' },
    { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'x' } },
  ])
  assert.equal(m.taskStrip('main', true, rows), null, 'main has no strip')
  assert.equal(m.taskStrip('thread', false, rows), null, 'nothing while nothing runs')
  const thread = m.taskStrip('thread', true, rows)
  assert.equal(thread.title, 'Working')
  assert.deepEqual(thread.steps.map((s: any) => [s.text, s.state]), [], 'a thread that only makes calls lists no steps: its calls are rows in its thread')
  assert.deepEqual(m.taskStrip('dev', true, rows).steps, [], 'nor does a ticket')
  assert.equal(m.taskStrip('dev', true, rows).title, 'Working on the ticket')
  assert.equal(m.taskStrip('dev', true, rows, new Map(), true).title, 'Building the view', 'a view build says what it does')
  const orient = m.taskStrip('orient', true, rows)
  assert.equal(orient.title, 'Orienting')
  assert.deepEqual(orient.steps.map((s: any) => s.state), [], 'an orientation lists no steps before its first subagent')
  assert.equal(orient.count, '', 'and counts none')
  assert.equal(thread.count, '', 'nor are a thread\'s calls')
  assert.equal(m.stepProgress(rows), '1/2', 'a running agent\'s row: its calls answered of those made')
  assert.equal(m.stepProgress([]), '')
  const all = { final: true, views: true, critique: true, report: true }
  const on = { final_notebook: true, propose_views: true, generate_report: true, critique: true, ultracode: true, effort: 'xhigh' }
  assert.deepEqual(m.startBody({ ...all, report: false }, '  focus  '), { ...on, generate_report: false, text: 'focus' })
  assert.deepEqual(m.startBody(all, ' '), on, 'empty instructions send no text, and Ultracode, at its level, is the default effort')
  // each pass can be turned off on its own
  assert.deepEqual(m.startBody({ ...all, final: false }, '', 'ultracode'), { ...on, final_notebook: false }, 'without the deck (the Final notebook until 2026-09-24) the report and the critique still run, on the analysis in its thread')
  assert.deepEqual(m.startBody({ ...all, critique: false, views: false }, '', 'high'), { ...on, propose_views: false, critique: false, ultracode: false, effort: 'high' }, 'a level below Ultracode is the effort, with Ultracode off')
  assert.deepEqual(m.startBody(all, '', 'low'), { ...on, ultracode: false, effort: 'low' }, 'every level Claude Code takes is offered')
  assert.deepEqual(m.startBody({ final: false, views: false, critique: false, report: false }, ''), { final_notebook: false, propose_views: false, generate_report: false, critique: false, ultracode: true, effort: 'xhigh' }, 'every switch off is still an orientation, its analysis in its thread')
  // the permission mode is one of Claude Code's own three: manual, auto and bypass
  assert.deepEqual(m.startBody(all, '', 'ultracode', 'bypass'), { ...on, permissions: 'bypass' }, 'the mode is sent')
  assert.deepEqual(m.startBody(all, '', 'ultracode', null), on, 'with none, the orientation keeps the analyst\'s own mode')
  assert.deepEqual(m.PERMISSION_OPTIONS.map((o: any) => [o.value, o.label, o.icon]), [['manual', 'Manual', 'pause'], ['auto', 'Auto', 'run'], ['bypass', 'Bypass', 'exclaim']])
  assert.equal(m.permissionChoice('auto'), 'auto')
  assert.equal(m.permissionChoice('bypassPermissions'), 'bypass')
  for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'dontAsk', undefined, null, 'unknown', 'constructor']) assert.equal(m.permissionChoice(mode), 'manual', `${mode} opens on Manual`)
  assert.match(m.BYPASS_WARNING, /^In Bypass Permissions mode, Claude Code will not ask for your approval/, 'Claude Code\'s own warning')
})

test('a dev ticket\'s thread opens on the analyst\'s own words, and an older log\'s shot lines are its pictures', () => {
  const main = [
    { type: 'user', ts: 't1', text: 'Group the board by round.', by: 'browser' },
    { type: 'done', ts: 't2' },
    { type: 'user', ts: 't3', text: 'the status line should show the zoom level. Please file that as a dev ticket.', by: 'browser' },
    { type: 'agent', ts: 't4', chat: 'd1', role: 'dev', title: 'ticket #1: Show the zoom level' },
    { type: 'agent', ts: 't5', chat: 'd2', role: 'dev', title: 'ticket #2: filed from the ticket box' },
  ]
  assert.deepEqual(m.ticketAsk(main, 'd1'), { text: 'the status line should show the zoom level. Please file that as a dev ticket.', index: 2 })
  assert.equal(m.ticketAsk([{ type: 'done', ts: 't' }, ...main.slice(3)], 'd1'), null, 'a ticket with no message of the analyst\'s in its turn')
  assert.equal(m.ticketAsk(main, 'nope'), null)
  const rows = m.foldRecords([
    { type: 'text', delta: '\n· worktree ready on dev/9fe50ac8\n' },
    { type: 'text', delta: '\n· before shot taken\n' },
    { type: 'text', delta: '\n· after shot taken\n' },
  ])
  const shown = m.withTicketShots(rows, { id: '9fe50ac8', before_shot: 'before.png', after_shot: null })
  assert.deepEqual(shown.map((r: any) => r.kind === 'shot' ? `shot:${r.phase}:${r.name}` : `${r.kind}:${r.text}`), ['note:worktree ready on dev/9fe50ac8', 'shot:before:before.png', 'note:after shot taken'])
  const logged = [...rows, { kind: 'shot', index: 9, phase: 'before', ticket: '9fe50ac8', name: 'before.png' }]
  assert.equal(m.withTicketShots(logged, { id: '9fe50ac8', before_shot: 'before.png' }).filter((r: any) => r.kind === 'shot').length, 1, 'a log with the shot record keeps its own')
})

test('a dev ticket\'s thread says why it failed, and main says in a few words how it ended', () => {
  assert.equal(m.ticketStatusText({ status: 'failed', error: 'gates failed after 3 attempts' }), 'Gates failed after 3 attempts')
  assert.equal(m.ticketStatusText({ status: 'needs manual merge', error: 'needs manual merge: a.ts; the change is kept on branch dev/x' }), 'Needs manual merge: a.ts; the change is kept on branch dev/x')
  assert.equal(m.ticketStatusText({ status: 'failed', error: null }), 'Failed')
  assert.equal(m.ticketStatusText({ status: 'rolled back', error: 'thimble did not come back after this change' }), 'thimble did not come back after this change', 'thimble keeps its lowercase name')
  assert.equal(m.ticketStatusText({ status: 'stopped', error: null }), 'Stopped')
  assert.equal(m.ticketStatusText({ status: 'queued', error: null }), 'Queued behind another ticket')
  assert.equal(m.ticketStatusText({ status: 'applied', error: null }), null, 'an applied ticket needs no line')
  assert.equal(m.ticketStatusText({ status: 'running', error: null }), null)
  assert.equal(m.ticketChipText({ status: 'applied', text: 'ticket #1 applied' }), 'Dev ticket applied')
  assert.equal(m.ticketChipText({ status: 'failed', text: 'ticket #1 failed: gates failed', ref: 'ticket:ab' }), 'Dev ticket failed')
  assert.equal(m.ticketChipText({ status: 'rolled back', text: 'ticket #1 rolled back: …', ref: 'ticket:ab' }), 'Dev ticket rolled back')
  assert.equal(m.ticketChipText({ status: 'failed', text: 'the change to the view Inbox failed…', ref: 'view:inbox' }), 'The change to the view failed, so it is as it was')
  assert.equal(m.ticketChipText({ text: 'ticket #1 applied; restart thimble\'s server to load it' }), 'ticket #1 applied; restart thimble\'s server to load it')
})

test('the orientation\'s thread shows its whole session, the summary it handed back in place of the line saying it did', () => {
  const rows = m.foldRecords([
    { type: 'user', ts: 't0', text: 'Orient the analyst.' },
    { type: 'text', delta: 'Reading the files first.' },
    { type: 'tool_use', ts: 't1', id: 'h', name: 'SubagentHandback', input: { message: 'The corpus is two files.' } },
    { type: 'tool_result', ts: 't2', id: 'h', summary: 'delivered' },
    { type: 'text', delta: "I've sent the summary back to the session that launched me." },
    { type: 'done', ts: 't3' },
  ])
  assert.deepEqual(m.orientMessages(rows).map((r: any) => r.text), ['Reading the files first.', 'The corpus is two files.'], 'the brief is the card\'s, the hand-back call and the line after it give way to the summary')
  const plain = m.foldRecords([{ type: 'text', delta: 'The summary.' }])
  assert.deepEqual(m.orientMessages(plain).map((r: any) => r.text), ['The summary.'], 'without a hand-back its messages are its own')
  // the orientation's scratch work is its thread, drawn in the chat with every tool call a chip to open or cite:
  // every call stays, a step where it was started, and each follow-up's message
  const calls = m.foldRecords([
    { type: 'user', ts: 't0', text: 'Orient the analyst.' },
    { type: 'tool_use', ts: 't1', id: 'r', name: 'Read', input: { file_path: '/data/mini/a.jsonl' } },
    { type: 'tool_use', ts: 't1', id: 'w', name: 'Workflow', input: { script: '' } },
    { type: 'agent', ts: 't1', chat: 's1', role: 'step', title: 'Read: read:a' },
    { type: 'tool_use', ts: 't1', id: 'c', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: 'Files' } },
    { type: 'tool_use', ts: 't1', id: 'k', name: 'Skill', input: { skill: 'pdf' } },
    { type: 'text', delta: 'Done.' },
    { type: 'user', ts: 't2', text: 'Look at refunds.', by: 'browser', event: 'orient-follow-up', run: 1 },
  ])
  assert.deepEqual(m.orientMessages(calls).map((r: any) => (r.kind === 'tool' ? r.name : r.kind === 'agent' ? `agent:${r.chat}` : r.text)), ['Read', 'Workflow', 'agent:s1', 'mcp__plugin_thimble_thimble__add_card', 'Skill', 'Done.', 'Look at refunds.'])
})

test('a thread\'s anchors split at the comma', () => {
  assert.deepEqual(m.threadAnchors({ anchor: 'cell:a1, cell:b2,report:report#s1' }), ['cell:a1', 'cell:b2', 'report:report#s1'])
  assert.deepEqual(m.threadAnchors({ anchor: null }), [])
})

test('boxPlace: a span or a tab takes the box under its last line, else over; a region beside it, else left, else under', () => {
  const [M, U, B, D] = [m.MARGIN, m.GAP_UNDER, m.GAP_BESIDE, m.BESIDE_DROP]
  const under = { under: true }
  const beside = { under: false }
  assert.equal(m.BOX_WIDTH, 236)
  const line = { left: 380, top: 500, right: 700, bottom: 520 }
  assert.deepEqual(m.boxPlace(line, 236, 38, 1280, 800, under), { left: 380, top: 520 + U, under: true }, 'a span: under its last line, on its left edge')
  const low = { left: 100, top: 770, right: 300, bottom: 790 }
  assert.deepEqual(m.boxPlace(low, 236, 38, 1280, 800, under), { left: 100, top: 770 - U - 38, under: true }, 'no room below: over it')
  const far = { left: 1200, top: 300, right: 1260, bottom: 320 }
  assert.deepEqual(m.boxPlace(far, 236, 38, 1280, 800, under), { left: 1280 - 236 - M, top: 320 + U, under: true }, 'kept inside the viewport')
  const cell = { left: 356, top: 96, right: 796, bottom: 560 }
  assert.deepEqual(m.boxPlace(cell, 236, 38, 1280, 800, beside), { left: 796 + B, top: 96 + D, under: false }, 'a tall region: beside it, a little below its top')
  const chip = { left: 95, top: 165, right: 237, bottom: 185 }
  assert.deepEqual(m.boxPlace(chip, 236, 38, 1280, 800, beside), { left: 237 + B, top: 165, under: false }, 'a short region: beside it, level with its top')
  const edge = { left: 1000, top: 200, right: 1200, bottom: 400 }
  assert.deepEqual(m.boxPlace(edge, 236, 38, 1280, 800, beside), { left: 1000 - B - 236, top: 200 + D, under: false }, 'no room at the right: at its left')
  const wide = { left: 20, top: 200, right: 1200, bottom: 400 }
  assert.deepEqual(m.boxPlace(wide, 236, 38, 1280, 800, beside), { left: 20, top: 400 + U, under: true }, 'no room on either side: under it')
  const bar = { left: 500, top: 150, right: 510, bottom: 250 }
  assert.deepEqual(m.boxPlace(bar, 236, 38, 1280, 800, { under: false, host: cell }), { left: 796 + B, top: 150, under: false }, 'inside a cell: beside the cell, level with the region')
  const deep = { left: 500, top: 700, right: 510, bottom: 720 }
  assert.deepEqual(m.boxPlace(deep, 236, 38, 1280, 800, { under: false, host: cell }), { left: 796 + B, top: 560 - 38, under: false }, 'the box keeps to the cell\'s height')
  // a report paragraph as wide as its page, the card sidebar at its left: the box goes under it, never over the sidebar
  const para = { left: 616, top: 417, right: 1340, bottom: 555 }
  const page = { left: 592, top: 84, right: 1406, bottom: 888 }
  assert.deepEqual(m.boxPlace(para, 236, 38, 1440, 900, { under: false, pane: page }), { left: 616, top: 555 + U, under: true }, 'no room at the right and the left leaves its pane: under it')
  assert.deepEqual(m.boxPlace(edge, 236, 38, 1280, 800, { under: false, pane: { left: 700, top: 0, right: 1280, bottom: 800 } }), { left: 1000 - B - 236, top: 200 + D, under: false }, 'the left inside the pane: at its left')
})

test('regionShape: a region takes its own radius, at least MIN_RADIUS, and is padded only when it has none', () => {
  assert.deepEqual(m.regionShape(0), { radius: m.MIN_RADIUS, pad: m.REGION_PAD })
  assert.deepEqual(m.regionShape(2), { radius: m.MIN_RADIUS, pad: 0 })
  assert.deepEqual(m.regionShape(8), { radius: 8, pad: 0 })
  assert.equal(m.MIN_RADIUS, 3)
})

test('the ⌘ cursors: the arrow and the I-beam in the accent, at one and two device pixels a px, with their hotspots', () => {
  const arrow = m.cursorValue('arrow', '#5135ff')
  assert.match(arrow, /^image-set\(url\("data:image\/svg\+xml,[^"]+"\) 1x, url\("data:image\/svg\+xml,[^"]+"\) 2x\) 3 2, default$/)
  const svgs = [...arrow.matchAll(/data:image\/svg\+xml,([^"]+)/g)].map((x: any) => decodeURIComponent(x[1]))
  assert.equal(svgs.length, 2)
  for (const svg of svgs) assert.match(svg, /fill="#5135ff"/, 'filled in the accent')
  assert.match(svgs[0], /width="28" height="28"/)
  assert.match(svgs[1], /width="56" height="56"/, 'the 2x image is twice the size')
  assert.match(svgs[1], /viewBox="0 0 28 28"/, 'over the same box, so the hotspot stays in px')
  assert.match(m.cursorValue('beam', 'rgb(1, 2, 3)'), / 11 11, text$/, 'the I-beam: its hotspot at the middle, the I-beam keyword behind it')
  assert.match(decodeURIComponent(m.cursorValue('beam', 'rgb(1, 2, 3)')), /stroke="rgb\(1, 2, 3\)"/)
  assert.doesNotMatch(m.cursorValue('arrow', '#000', false), /image-set/, 'the one-image form for a browser without image-set()')
  const c = m.cmdCursors('#d6336c')
  assert.equal(c, m.cmdCursors('#d6336c'), 'the same accent gives the same values, built once')
  assert.match(decodeURIComponent(c.arrow), /#d6336c/)
  assert.match(c.beam, /, text$/)
})

test('lineAround: the line around the offset, trimmed; a long line cut around the offset at spaces', () => {
  const text = 'first line\n  the second line here  \nthird'
  const at = text.indexOf('second')
  const { start, end } = m.lineAround(text, at)
  assert.equal(text.slice(start, end), 'the second line here')
  assert.equal(text.slice(...(Object.values(m.lineAround(text, 2)) as number[])), 'first line')
  assert.equal(text.slice(...(Object.values(m.lineAround(text, text.length)) as number[])), 'third')
  const long = Array.from({ length: 400 }, (_: any, i: any) => `w${i}`).join(' ')
  const mid = long.indexOf('w200')
  const cut = m.lineAround(long, mid, 100)
  const piece = long.slice(cut.start, cut.end)
  assert.ok(piece.length <= 100 && piece.includes('w200'), 'cut to the limit around the offset')
  assert.ok(!piece.startsWith(' ') && long[cut.start - 1] === ' ' && long[cut.end] === ' ', 'at spaces')
  assert.ok(m.CHUNK_MAX >= 1000)
})

test('lastLineOf: the last text piece, widened by the inline boxes on its line; a card-sized box is not on the line', () => {
  const pieces = [
    { left: 20, top: 100, right: 400, bottom: 118 },
    { left: 44, top: 118, right: 60, bottom: 136 },
  ]
  const chip = { left: 20, top: 119, right: 40, bottom: 135 }
  const card = { left: 0, top: 0, right: 420, bottom: 140 }
  assert.deepEqual(m.lastLineOf(pieces, [chip, card]), { left: 20, top: 118, right: 60, bottom: 136 })
  assert.deepEqual(m.lastLineOf(pieces, []), pieces[1])
  assert.equal(m.lastLineOf([], [chip]), null)
})

test('clipBox: a box cut to the clip; a box wholly outside it, or a sliver, is gone', () => {
  const clip = { left: 0, top: 100, right: 200, bottom: 175 }
  assert.deepEqual(m.clipBox({ left: 10, top: 150, right: 90, bottom: 168 }, clip), { left: 10, top: 150, right: 90, bottom: 168 }, 'a line inside stays')
  assert.deepEqual(m.clipBox({ left: 150, top: 160, right: 260, bottom: 178 }, clip), { left: 150, top: 160, right: 200, bottom: 175 }, 'a line across the edge is cut')
  assert.equal(m.clipBox({ left: 10, top: 175, right: 90, bottom: 193 }, clip), null, 'a line under the clip is gone')
  assert.equal(m.clipBox({ left: 10, top: 174.8, right: 90, bottom: 192.8 }, clip), null, 'a sliver under half a pixel is gone')
  assert.deepEqual(m.clipBox({ left: 10, top: 500, right: 90, bottom: 518 }, null), { left: 10, top: 500, right: 90, bottom: 518 }, 'no clip keeps the box')
})

test('startGateOpen: the Start card stays until an orientation is asked for, whatever main holds', () => {
  // an analyst who asked something in the terminal first still has the orientation to start
  assert.equal(m.startGateOpen(null), true)
  assert.equal(m.startGateOpen(undefined, 0), true)
  for (const s of ['requested', 'running', 'done', 'failed', 'stopped']) assert.equal(m.startGateOpen(s), false, s)
  assert.equal(m.startGateOpen(null, 1), false, 'an orientation with a thread and no record, from an older version')
})

test('togglePass: each switch is on its own, and the choice lists them in order', () => {
  // ultracode is an effort level, not a switch, so the gate's switches are the passes alone, and each can be turned
  // off without the others
  assert.deepEqual(m.chosenPasses(m.ALL_ON), ['final', 'views', 'critique', 'report'], 'every switch starts on')
  // `final` is the Orientation deck's switch
  const noFinal = m.togglePass(m.ALL_ON, 'final')
  assert.deepEqual(noFinal, { final: false, views: true, critique: true, report: true }, 'the others stay as they were')
  assert.deepEqual(m.chosenPasses(noFinal), ['views', 'critique', 'report'])
  assert.deepEqual(m.togglePass(noFinal, 'final'), m.ALL_ON)
  assert.deepEqual(m.chosenPasses(m.togglePass(noFinal, 'report')), ['views', 'critique'], 'the report turns off on its own')
  assert.deepEqual(m.chosenPasses(m.togglePass(m.ALL_ON, 'critique')), ['final', 'views', 'report'])
  assert.deepEqual(m.chosenPasses(m.togglePass(m.ALL_ON, 'views')), ['final', 'critique', 'report'], 'the views turn off on their own')
  assert.deepEqual(m.chosenPasses({ final: false, views: false, critique: false, report: false }), [])
  assert.deepEqual(m.PASSES.map((p: any) => p.id), ['final', 'views', 'critique', 'report'])
  assert.equal(m.PASSES.some((p: any) => 'note' in p), false, 'a pass carries a label, no prose')
})

test('the effort menus: Claude Code\'s levels then ultracode; main\'s opens on its session\'s effort, the orientation\'s on ultracode', () => {
  assert.deepEqual(m.EFFORT_CHOICES, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], 'the gate and the composer offer the same menu')
  // the orientation opens on ultracode whatever the analyst's settings name; main on its session's
  assert.equal(m.ORIENT_DEFAULT_EFFORT, 'ultracode', 'the orientation runs with Ultracode until its role is given another effort')
  const base = { session: 's', cwd: '/c', since: 't' }
  assert.equal(m.mainEffort(null), 'high', "thimble's default for main")
  assert.equal(m.mainEffort({ ...base, settings_effort: 'ultracode' }), 'ultracode', 'before main has replied, the analyst\'s own choice')
  assert.equal(m.mainEffort({ ...base, settings_effort: 'ultracode', effort: 'xhigh' }), 'ultracode', 'a reply names the level Ultracode runs at')
  assert.equal(m.mainEffort({ ...base, settings_effort: 'ultracode', effort: 'low' }), 'low', 'a level changed in the terminal is what runs')
  assert.equal(m.mainEffort({ ...base, settings_effort: 'ultracode', effort: 'xhigh', effort_choice: 'max' }), 'max', "the chip's choice wins")
  assert.equal(m.mainEffort({ ...base, effort: 'high' }), 'high')
  // efforts are written in lower case, ultracode too; '' is a subagent's, the effort of its session
  assert.equal(m.effortWord('ultracode'), 'ultracode')
  assert.equal(m.effortWord(''), "the session's")
})

test('mainFast: fast mode is a switch while main runs fast and once the line has switched it', () => {
  // Claude Code 2.1.280 turns a running session's fast mode off and on again, but cannot turn it on in a session that started without it
  const base = { session: 's', cwd: '/c', since: 't' }
  assert.equal(m.mainFast(null), null)
  assert.equal(m.mainFast({ ...base, fast: false }), null, 'a session that runs without fast mode gets no switch: its bolt shows it off, with the tip')
  assert.equal(m.mainFast({ ...base, fast: true }), true)
  assert.equal(m.mainFast({ ...base, fast: false, fast_choice: false }), false, 'turned off here: the switch stays, off')
  assert.equal(m.mainFast({ ...base, fast: false, fast_choice: true }), true, 'turned back on before the next reply says so')
})

test('toolSummary names the call that started a subagent by its description', () => {
  const agent = { description: 'orient', subagent_type: 'thimble:thimble-orient', prompt: 'Orient the analyst in the whole corpus.' }
  assert.equal(m.toolSummary('Agent', agent), 'orient')
  assert.equal(m.toolSummary('Agent', { subagent_type: 'thimble:thimble-orient' }), 'thimble:thimble-orient')
})

test('inputRows leaves out the fields the head summary already prints', () => {
  const glob = { pattern: '**/*', path: '/data/x' }
  assert.deepEqual(m.inputRows(glob, m.toolSummary('Glob', glob)), [])
  const grep = { pattern: 'collude', glob: '*.md', '-i': true }
  assert.deepEqual(
    m.inputRows(grep, m.toolSummary('Grep', grep)).map((r: any) => r.key),
    ['glob', '-i'],
  )
  const cell = { question: 'How many runs?', code: 'SELECT count(*)\nFROM runs' }
  assert.deepEqual(
    m.inputRows(cell, m.toolSummary('add_card', cell)).map((r: any) => [r.key, r.kind]),
    [['code', 'code']],
  )
  const sh = { command: 'ls -la', description: 'List files' }
  assert.deepEqual(m.inputRows(sh, m.toolSummary('Bash', sh)).map((r: any) => r.key), ['description'])
  // with no summary every field stays
  assert.deepEqual(m.inputRows(glob).map((r: any) => r.key), ['pattern', 'path'])
})

// ----------------------------------------------------------------------------- the element a thread is opened on

const node = (tag: string, classes: string[] = [], extra: object = {}) => ({ tag, classes, ...extra })

test('selectorPath: from the nearest anchor down to the element, tag and classes, state words dropped', () => {
  const chain = [
    node('span', ['chip-text']),
    node('button', ['chip', 'chip-value', 'chip-act', 'active']),
    node('div', ['card-foot']),
    node('div', ['card', 'canvas-card', 'selected'], { anchor: 'cell:abcd1234' }),
    node('div', ['canvas-column']),
    node('div', [], { panel: 'canvas' }),
  ]
  assert.equal(m.selectorPath(chain), '[data-anchor="cell:abcd1234"] > div.card-foot > button.chip.chip-value.chip-act > span.chip-text')
  assert.deepEqual(m.describe(chain.slice(1)), { surface: 'canvas', element: 'chip', selector: '[data-anchor="cell:abcd1234"] > div.card-foot > button.chip.chip-value.chip-act' })
  assert.equal(m.selectorPath(chain.slice(3)), '[data-anchor="cell:abcd1234"]', 'the anchor element itself is its selector')
})

test('selectorPath: without an anchor the path roots at the panel, at most PATH_LEVELS segments, never an id', () => {
  const chain = [node('svg', ['icon']), node('button', ['btn', 'btn-icon']), node('header', ['shell-topbar'], { panel: 'topbar' })]
  assert.equal(m.selectorPath(chain), '[data-panel="topbar"] > button.btn.btn-icon > svg.icon')
  const deep = Array.from({ length: 10 }, (_: any, i: any) => node('div', [`l${i}`]))
  const path = m.selectorPath(deep)
  assert.equal(path.split(' > ').length, m.PATH_LEVELS)
  assert.equal(path, 'div.l5 > div.l4 > div.l3 > div.l2 > div.l1 > div.l0')
  assert.equal(m.selectorPath([node('div', ['a:b', '1x'])]), 'div.a\\:b.\\31 x', 'odd class names are escaped')
  assert.equal(m.selectorPath([node('div', [], { anchor: 'file:a "b"' })]), '[data-anchor="file:a \\"b\\""]')
})

test('stableClassOf: the wu- family first, then the most specific component class; none for a class that names nothing', () => {
  assert.equal(m.stableClassOf(['card', 'chat-row', 'chat-task']), 'chat-row', 'the specific class beats the card frame')
  assert.equal(m.stableClassOf(['card', 'wu-figure']), 'wu-figure', 'the wu- family beats the frame')
  assert.equal(m.stableClassOf(['nothing-stable']), undefined)
  assert.equal(m.describe([node('em', ['nothing-stable'])]).element, 'em', 'an element with no component class is named by its tag')
})

test('a step of the orientation is its own kind of chat, opened from the orientation\'s card and nested under it in the tree', () => {
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-23T10:00:00Z', parent: null }
  const orient = { ...main, id: 'or1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-23T10:01:00Z', parent: 'main', status: 'running' }
  const step = { ...main, id: 's1', kind: 'agent', role: 'step', title: 'Read runs.jsonl', created_at: '2026-09-23T10:02:00Z', parent: 'or1', status: 'running' }
  assert.equal(m.threadKind(step), 'step')
  const items = m.pickItems([main, orient, step], () => false, () => false)
  assert.deepEqual(items.map((i: any) => [i.label, i.title, i.parent, i.running]), [['main', '', null, false], ['orient', 'orient', null, true], ['orient/Read runs.jsonl', 'Read runs.jsonl', 'or1', true]])
  const rows = m.foldRecords([{ type: 'agent', chat: 's1', role: 'step', title: 'Read runs.jsonl' }])
  const strip = m.taskStrip('orient', true, rows, new Map([['s1', step]]))
  assert.deepEqual([strip.title, strip.steps.map((s: any) => [s.text, s.state])], ['Orienting', [['Read runs.jsonl', 'running']]], 'the strip lists its agents by name, without the orientation\'s path')
  assert.equal(strip.count, '0/1', 'its count is of subagents')
  // the orientation's calls around its readers are not counted: two readers, one ended, read 1/2
  const two = m.foldRecords([
    { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', id: 'a', summary: 'ok' },
    { type: 'agent', chat: 's1', role: 'step', title: 'Read runs.jsonl' },
    { type: 'agent', chat: 's2', role: 'step', title: 'Read admin' },
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'wc -l' } },
  ])
  const counted = m.taskStrip('orient', true, two, new Map([['s1', { ...step, status: 'failed' }], ['s2', { ...step, id: 's2' }]]))
  assert.equal(counted.steps.length, 2)
  assert.equal(counted.count, '1/2', 'a failed reader counts as ended')
  assert.equal(m.subagentCount([{ state: 'done' }, { state: 'failed' }]), '2 done')
  // a view's build and a check list their subagents alone too, their calls never
  const build = m.taskStrip('dev', true, two, new Map([['s1', { ...step, status: 'done' }], ['s2', { ...step, id: 's2' }]]), true)
  assert.deepEqual([build.title, build.steps.length, build.count], ['Building the view', 2, '1/2'])
  assert.deepEqual(m.taskStrip('check', true, two, new Map([['s1', step], ['s2', { ...step, id: 's2' }]])).steps.length, 2)
  assert.equal(m.subagentCount([]), '')
})

test('a step is named by its path under the orientation, and a finished one stays under it with its check and time', () => {
  // a step reads as its path, such as orient/read: prompt-manifests, and a finished one stays under the orientation
  // with a check and its time
  assert.equal(m.stepName('Read: read:harness-tools'), 'read: harness-tools', 'the key\'s own copy of the phase goes')
  assert.equal(m.stepName('Critique: critic'), 'critique: critic')
  assert.equal(m.stepName('Critique: refute:questions'), 'critique: refute:questions', 'another prefix stays')
  assert.equal(m.stepName('Verify report:report'), 'Verify report:report', 'a title with no phase stays')
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-23T10:00:00Z', parent: null }
  const orient = { ...main, id: 'or1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-23T10:01:00Z', parent: 'main', status: 'running' }
  const done = { ...main, id: 's1', kind: 'agent', role: 'step', title: 'Read: read:prompts-manifests', created_at: '2026-09-23T10:02:00Z', parent: 'or1', status: 'done', ts_end: '2026-09-23T10:09:00Z' }
  const failed = { ...done, id: 's2', title: 'Read: read:board', status: 'failed' }
  const going = { ...done, id: 's3', title: 'Critique: critic', status: 'running', ts_end: null }
  const items = m.pickItems([main, orient, done, failed, going], () => false, () => false)
  assert.deepEqual(items.map((i: any) => [i.label, i.title]), [['main', ''], ['orient', 'orient'], ['orient/read: prompts-manifests', 'read: prompts-manifests'], ['orient/read: board', 'read: board'], ['orient/critique: critic', 'critique: critic']])
  const nodes = m.threadNodes(items)
  const byId = (id: any) => nodes.find((n: any) => n.id === id)
  assert.equal(byId('s1').ended, 'done', 'a finished step stays among the rows under its running orientation')
  assert.match(byId('s1').time, /^\d\d:\d\d$/, 'with the time it finished')
  assert.equal(byId('s2').ended, 'failed')
  assert.equal(byId('s3').ended, undefined)
  assert.equal(byId('s3').time, undefined, 'a running step shows no time')
  assert.deepEqual(rowIds(m.treeRows(nodes)), [['main', 0], ['or1', 0], ['s1', 1], ['s2', 1], ['s3', 1]])
  // the latest orientation finished: it stays at the top level with its steps, the green check and the time it ended
  const later = m.threadNodes(m.pickItems([main, { ...orient, status: 'done', ts_end: '2026-09-23T10:20:00Z' }, done, failed, { ...going, status: 'done' }], () => false, () => false))
  assert.deepEqual(rowIds(m.treeRows(later)), [['main', 0], ['or1', 0], ['s1', 1], ['s2', 1], ['s3', 1]])
  assert.equal(later.find((n: any) => n.id === 'or1').ended, 'done')
})

test('a writer is a session of its own under main, named for its document and numbered from its second run, with its steps nested under it', () => {
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-23T10:00:00Z', parent: null }
  const old = { ...main, id: 'w0', kind: 'agent', role: 'writer', title: 'Write report', doc: 'report', created_at: '2026-09-23T10:01:00Z', parent: 'main', status: 'done' }
  const writer = { ...old, id: 'w1', created_at: '2026-09-23T10:05:00Z', status: 'running' }
  const slides = { ...main, id: 'w2', kind: 'agent', role: 'writer', title: 'Write slides', created_at: '2026-09-23T10:06:00Z', parent: 'main', status: 'running' }
  const verify = { ...main, id: 's1', kind: 'agent', role: 'step', title: 'Verify report:report', created_at: '2026-09-23T10:07:00Z', parent: 'w1', status: 'running' }
  assert.equal(m.threadKind(writer), 'writer')
  assert.equal(m.writerDoc(slides), 'slides', 'a chat without its doc is named from its title')
  const items = m.pickItems([main, old, writer, slides, verify], () => false, () => false)
  assert.deepEqual(items.map((i: any) => [i.label, i.title, i.parent, i.running]), [
    ['main', '', null, false],
    ['write-report', 'write-report', 'main', false],
    ['write-report-2', 'write-report-2', 'main', true],
    ['write-report-2/Verify report:report', 'Verify report:report', 'w1', true],
    ['write-slides', 'write-slides', 'main', true],
  ])
  const nodes = m.threadNodes(items)
  assert.deepEqual(rowIds(m.treeRows(nodes)), [['main', 0], ['w1', 1], ['s1', 2], ['w2', 1], ['w0', 1]], 'the finished run stays under main, after the ones at work since')
  const rows = m.foldRecords([{ type: 'agent', chat: 's1', role: 'step', title: 'Verify report:report' }])
  const strip = m.taskStrip('writer', true, rows, new Map([['s1', verify]]))
  assert.deepEqual([strip.title, strip.steps.map((s: any) => [s.text, s.state])], ['Writing', [['Verify report:report', 'running']]])
})

test('a check\'s run is a session of its own: `check/<name>` under main while it runs, and its pane\'s once it ends', () => {
  // the Checks pane's spinner opens it (report/Checks.tsx); a run after a save starts by itself, so the analyst did not
  // start it and the tree lists it only while it runs
  const main = { id: 'main', kind: 'main', role: 'main', title: '', created_at: '2026-09-24T10:00:00Z', parent: null }
  const done = { ...main, id: 'k1', kind: 'agent', role: 'check', title: 'Unverified', created_at: '2026-09-24T10:01:00Z', parent: 'main', status: 'done', ts_end: '2026-09-24T10:03:00Z' }
  const going = { ...main, id: 'k2', kind: 'agent', role: 'check', title: 'check/Depends on budget.xlsx', created_at: '2026-09-24T10:05:00Z', parent: 'main', status: 'running' }
  assert.equal(m.threadKind(going), 'check')
  assert.equal(m.checkLabel('check Unverified'), 'check/Unverified')
  assert.equal(m.checkLabel(''), 'check/run')
  const items = m.pickItems([main, done, going], () => false, () => true)
  assert.deepEqual(items.map((i: any) => [i.label, i.title, i.parent, i.running, i.unread, !!i.hidden]), [
    ['main', '', null, false, true, false],
    ['check/Unverified', 'Unverified', 'main', false, false, true],
    ['check/Depends on budget.xlsx', 'Depends on budget.xlsx', 'main', true, false, false],
  ], 'a run reports in its pane, so its chat is never unread, and the finished one is left to its pane')
  const nodes = m.threadNodes(items)
  assert.deepEqual(nodes.map((n: any) => [n.id, n.ended ?? null, n.time != null]), [
    ['main', null, false],
    ['k2', null, false],
  ], 'the running one under main with no time')
})

test('a thread offers Ask again only under a run that ended without a reply, until something comes after it', () => {
  const q = { type: 'user', text: 'why?' }
  const stop = (kind: any) => ({ type: 'error', message: 'x', kind })
  assert.equal(m.canAskAgain([q, stop('session-ended')], false), true, 'its session ended')
  assert.equal(m.canAskAgain([q, stop('unanswered')], false), true, 'main passed it by')
  assert.equal(m.canAskAgain([q, stop('failed')], false), true, 'its fork failed')
  assert.equal(m.canAskAgain([q, stop('session-ended')], true), false, 'not while it works')
  assert.equal(m.canAskAgain([q, stop('session-ended'), { type: 'again' }], false), false, 'asked again already')
  assert.equal(m.canAskAgain([q, stop('session-ended'), { type: 'user', text: 'and?' }], false), false, 'a new question went out')
  assert.equal(m.canAskAgain([q, { type: 'text', delta: 'Because.', reply: true }], false), false, 'answered')
  assert.equal(m.canAskAgain([q, { type: 'done' }], false), false, 'a run that acted and finished')
  assert.equal(m.canAskAgain([q], false), false, 'a question alone may still be on its way')
  assert.equal(m.canAskAgain([q, stop('some-other-error')], false), false)
})

test("a card's parts: the line around an offset, a mark's fields, the band along a card's edge", () => {
  const out = 'rows 12480\ncols 32\n\nwikis 4'
  assert.deepEqual(lineAt(out, 0), { start: 0, end: 10, n: 1 })
  assert.deepEqual(lineAt(out, 13), { start: 11, end: 18, n: 2 })
  assert.deepEqual(lineAt(out, 11), { start: 11, end: 18, n: 2 }, 'the start of a line is that line')
  assert.deepEqual(lineAt(out, out.length), { start: 20, end: 27, n: 4 })
  assert.equal(fieldValue(11206), '11,206')
  assert.equal(fieldValue(0.12345), '0.1235')
  assert.equal(fieldValue(1781740800000), '2026-06-18', 'a datum time in milliseconds reads as its day')
  assert.equal(fieldValue(new Date(Date.UTC(2026, 5, 18, 14, 30))), '2026-06-18T14:30:00Z')
  assert.equal(fieldValue('north'), 'north')
  assert.equal(markText('rect', { datum: { wiki: 'north', saves: 11206, saves_start: 0, saves_end: 11206, _vgsid_: 3 } }), 'bar · wiki: north · saves: 11,206', 'a stack\'s bounds and Vega\'s own fields left out')
  assert.equal(markText('area', { datum: { day: 1779580800000, n: 16 }, tooltip: { day: '2026-05-24', 'agent saves': '16' } }), 'point on an area · day: 2026-05-24 · agent saves: 16', 'the chart\'s tooltip where it has one')
  assert.equal(markText('arc', { datum: {}, tooltip: 'north: 85%' }), 'slice · north: 85%')
  const card = { left: 0, top: 0, right: 400, bottom: 300 }
  assert.equal(nearEdge(card, 4, 150), true)
  assert.equal(nearEdge(card, 200, 296), true)
  assert.equal(nearEdge(card, 200, 150), false)
})
