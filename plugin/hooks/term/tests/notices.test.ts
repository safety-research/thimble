// Notices (notices.tsx, SPEC-v2 3.20): each new notice, the workspace's or the terminal's own, posts one toast, once;
// those there at activation post none. Each is one row above the prompt (band.tsx): `notice` in red, its words in the
// text color, whole and wrapped where its acts begin, its acts at the right in the accent, each saying what its press
// does. The newest shows; the others wait behind one row, `5 more notices ›`. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { modActWords, moreNotices, noticeActWords, seeWords } from '../notices'
import { COLORS } from '../paint'
import { focusedBrief } from '../panel'
import { CWD, LABEL, WS, aboveAt, paneAt, panelWorld, pressBrowser, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const NOTICE = { id: 'n1', key: 'check:important-details', kind: 'check', text: 'The check Important details failed: its model call was refused.', agent: 'Important details', chat: '', at: '2026-10-16T16:10:00Z', acts: [] }

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test('each new notice posts one toast, once; the notices there at activation post none', T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [{ ...NOTICE, id: 'n0', text: 'An old failure.' }]
  await start($, w)
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('An old failure.'))).toEqual([])
  w.states.home.notices = [NOTICE, { ...NOTICE, id: 'n0', text: 'An old failure.' }]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(w.toasts.filter(t => t === NOTICE.text)).toEqual([NOTICE.text])
  // the terminal's own: one toast for a key posted twice
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await pressBrowser($, w)
  await w.clock.advance(6000)
  await pressBrowser($, w)
  // a notice toasts as it is: Claude Code shows the plugin's name before a toast (no `thimble: thimble's …`)
  expect(w.toasts.filter(t => t.startsWith("thimble's page did not start")).length).toBe(1)
  await m.unmount()
})

// ------------------------------------------------------------------------------------------------ the notice rows

const SWITCHED = "Claude's safeguards switched a reply of the orientation from Opus 5.5 to Opus 4.8."
const ORIENT = { id: 'n2', key: 'safeguards:c-orient', kind: 'safeguards', text: SWITCHED, agent: 'Orientation', chat: 'c-orient', open: 'agent', at: '2026-10-17T00:05:00Z', acts: [] }

type Node = { type?: string; key?: unknown; props?: Record<string, unknown> & { children?: unknown }; children?: unknown }

/** The Text runs inside an element, each with its look. */
function texts(n: unknown, out: { s: string; color?: unknown; bold?: unknown; dim?: unknown; hover?: unknown; wrap?: unknown }[] = []): typeof out {
  if (Array.isArray(n)) n.forEach(x => texts(x, out))
  else if (n && typeof n === 'object') {
    const o = n as Node & { hover?: unknown }
    if (o.type === 'Text') out.push({ s: words(o), color: o.props?.color, bold: o.props?.bold, dim: o.props?.dimColor, hover: o.hover ?? o.props?.hover, wrap: o.props?.wrap })
    else texts(o.children ?? o.props?.children, out)
  }
  return out
}

test("a notice is one row: `notice` in red on the label column, its words in the text color whole and wrapped where its acts begin, the act that opens its agent's chat named for it (`see the orientation ›`)", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [ORIENT]
  await start($, w)
  // 100 columns: the label column (17), the words, two cells, `see the orientation ›  dismiss` (30) at the right
  const m = (await $.ui.mount(aboveAt(100))) as unknown as M
  const row = await m.find({ type: 'Box', key: 'above-notice-n2' })
  expect(words(row)).toBe(`  notice${SWITCHED}see the orientation ›dismiss`)
  const looks = texts(row)
  // the label in red; the words in the text color, not a red paragraph, whole and wrapped (bug hunt C21: never cut off)
  expect(looks[0]).toMatchObject({ s: '  notice', color: COLORS.problem })
  expect(looks[1]).toMatchObject({ s: SWITCHED, wrap: 'wrap' })
  expect(looks[1]!.color).toBeUndefined()
  // the acts in the accent, underlined under the pointer, the first bold
  expect(looks.find(l => l.s === 'see the orientation ›')).toMatchObject({ color: COLORS.accent, bold: true, hover: { underline: true } })
  expect(looks.find(l => l.s === 'dismiss')).toMatchObject({ color: COLORS.accent, hover: { underline: true } })
  expect(looks.find(l => l.s === 'dismiss')!.bold).toBeUndefined()
  expect(JSON.stringify(row)).not.toContain('open ›')
  // one notice: no row of more
  expect(await m.find({ type: 'Box', key: 'above-notices-more' })).toBeUndefined()
  // the press opens the orientation's chat in the panel, as its words say
  await m.press({ key: 'above-notice-n2-open' })
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Orientation')
  await m.unmount()
})

test("bug hunt B5: notices with the same words are one row with their count first (`3× …`): one toast, and `dismiss` takes them all", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m0 = (await $.ui.mount(aboveAt(150))) as unknown as M
  await w.clock.settle()
  await m0.unmount()
  // three of the orientation's helpers switched to another model: three notices, one row
  const helper = (id: string, chat: string) => ({ ...ORIENT, id, key: `safeguards:${chat}`, agent: 'Orientation helper', chat })
  w.states.home.notices = [helper('h3', 'c3'), helper('h2', 'c2'), helper('h1', 'c1'), NOTICE]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(150))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'above-notice-h3' }))).toBe(`  notice3× ${SWITCHED}see the orientation helper ›dismiss`)
  expect(await m.find({ type: 'Box', key: 'above-notice-h2' })).toBeUndefined()
  expect(await m.find({ type: 'Box', key: 'above-notice-h1' })).toBeUndefined()
  // the older notice waits behind its row
  expect(words(await m.find({ type: 'Box', key: 'above-notices-more' }))).toBe(`  ${moreNotices(1)}`)
  expect(w.toasts.filter(t => t === SWITCHED).length).toBe(1)
  // a fourth joins the row and toasts nothing
  w.states.home.notices = [helper('h4', 'c4'), helper('h3', 'c3'), helper('h2', 'c2'), helper('h1', 'c1'), NOTICE]
  w.stamps.set(`${WS}/notices.json`, 10)
  await w.clock.advance(1100)
  await w.clock.settle()
  await m.unmount()
  const four = (await $.ui.mount(aboveAt(150))) as unknown as M
  expect(words(await four.find({ type: 'Box', key: 'above-notice-h4' }))).toContain(`4× ${SWITCHED}`)
  expect(w.toasts.filter(t => t === SWITCHED).length).toBe(1)
  await four.press({ key: 'above-notice-h4-dismiss' })
  await w.clock.settle()
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['h4', 'h3', 'h2', 'h1'])
  await four.unmount()
  const after = (await $.ui.mount(aboveAt(150))) as unknown as M
  expect(await after.find({ type: 'Box', key: 'above-notice-h4' })).toBeUndefined()
  expect(words(await after.find({ type: 'Box', key: 'above-notice-n1' }))).toContain(NOTICE.text)
  expect(await after.find({ type: 'Box', key: 'above-notices-more' })).toBeUndefined()
  await after.unmount()
})

// bug hunt B5 note and C21: a view proposal, six notices and the SSH row took 14 of 58 rows above the prompt
const LABEL_FAILED = { id: 'n7', key: 'label:k1', kind: 'label', text: "The label retry storms couldn't label 184 of 2,064 records: Claude's safeguards stopped its request; rephrase or narrow the label and run it again.", agent: 'Label: retry storms', chat: '', at: '2026-10-17T04:48:00Z', acts: [{ label: 'See the label', act: 'label-open', slug: 'k1' }] }
const BUILD_FAILED = { id: 'n8', key: 'agent:view:run-map', kind: 'agent', text: 'The view Run Map failed to build: the page did not load.', agent: 'View build: Run Map', chat: '', at: '2026-10-17T04:40:00Z', acts: [{ label: 'Retry', act: 'view-retry', slug: 'run-map' }] }

test('bug hunt B5 and C21: the newest notice shows in full and the others behind one row, `5 more notices ›`, which shows them there, newest first, with their acts and `dismiss all`', T, async ($, on) => {
  const w = panelWorld(on)
  const helper = (id: string, chat: string, min: number) => ({ ...ORIENT, id, key: `safeguards:${chat}`, agent: 'Orientation helper', chat, at: `2026-10-17T04:${min}:00Z` })
  w.states.home.notices = [LABEL_FAILED, BUILD_FAILED, ORIENT_FAILED, helper('h2', 'c2', 33), helper('h1', 'c1', 32), { ...NOTICE, at: '2026-10-17T04:20:00Z' }]
  await start($, w)
  // and one of the terminal's own, posted before them by the test's clock
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await pressBrowser($, w)
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(100))) as unknown as M
  // the newest, whole and wrapped, then one row for the five others (the two helpers' notices are one)
  expect(texts(await m.find({ type: 'Box', key: 'above-notice-n7' }))[1]).toMatchObject({ s: LABEL_FAILED.text, wrap: 'wrap' })
  for (const key of ['above-notice-n8', 'above-notice-n5', 'above-notice-h2', 'above-notice-n1', 'above-mod-open-failed']) expect(await m.find({ type: 'Box', key })).toBeUndefined()
  expect(words(await m.find({ type: 'Box', key: 'above-notices-more' }))).toBe('  5 more notices ›')
  await m.press({ key: 'above-notices-toggle' })
  await w.clock.settle()
  await m.unmount()
  const open = (await $.ui.mount(aboveAt(100))) as unknown as M
  const drawn = JSON.stringify(await open.drawn())
  const order = ['above-notice-n7', 'above-notice-n8', 'above-notice-n5', 'above-notice-h2', 'above-notice-n1', 'above-mod-open-failed', 'above-notices-more'].map(k => drawn.indexOf(`"${k}"`))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(words(await open.find({ type: 'Box', key: 'above-notices-more' }))).toBe('  show fewerdismiss all')
  // each notice's acts work from the list: the view build's `retry`
  await open.press({ key: 'above-notice-n8-act-0' })
  await w.clock.settle()
  expect(w.acts.filter(a => a.kind === 'view-retry').map(a => a.payload)).toEqual([{ slug: 'run-map', notice: 'n8' }])
  await open.unmount()
  const rest = (await $.ui.mount(aboveAt(100))) as unknown as M
  expect(await rest.find({ type: 'Box', key: 'above-notice-n8' })).toBeUndefined()
  // `dismiss all`: every notice, the workspace's and the terminal's own
  await rest.press({ key: 'above-notices-all' })
  await w.clock.settle()
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['n7', 'n5', 'h2', 'h1', 'n1'])
  await rest.unmount()
  const none = (await $.ui.mount(aboveAt(100))) as unknown as M
  expect(JSON.stringify(await none.drawn())).not.toMatch(/"above-(notice|mod|notices)-/)
  await none.unmount()
})

test("a notice's acts say what their press does: `how to fix it` for a toast that says how, `allow in the browser ›` for a ticket, the agent or the thread a press opens", () => {
  expect(noticeActWords({ act: 'settings', label: 'open settings' })).toBe('how to fix it')
  expect(noticeActWords({ act: 'ticket-open', label: 'open ›' })).toBe('allow in the browser ›')
  expect(noticeActWords({ act: 'view-retry', label: 'retry' })).toBe('retry')
  expect(noticeActWords({ act: 'view-propose-now', label: 'Try again' })).toBe('try again')
  expect(modActWords('doctor')).toBe('how to fix it')
  expect(modActWords('copy link')).toBe('copy link')
  expect(seeWords({ open: 'agent', agent: 'Orientation' })).toBe('see the orientation ›')
  expect(seeWords({ open: 'agent', agent: 'View build: Agent Network' })).toBe('see the view build ›')
  expect(seeWords({ open: 'agent', agent: 'the writer' })).toBe('see the writer ›')
  expect(seeWords({ open: 'agent', agent: '' })).toBe('see the agent ›')
  expect(seeWords({ open: 'thread', agent: 'Side thread: Which line?' })).toBe('see the thread ›')
})

test("the terminal's own notice: `doctor` reads `how to fix it`, and its press says in a toast where to look", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await pressBrowser($, w)
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  const row = await m.find({ type: 'Box', key: 'above-mod-open-failed' })
  expect(words(row)).toBe("  noticethimble's page did not start: no servertry againhow to fix itdismiss")
  expect(texts(row).find(l => l.s === 'try again')).toMatchObject({ color: COLORS.accent, bold: true })
  await m.press({ key: 'above-mod-open-failed-act-1' })
  await w.clock.settle()
  expect(w.toasts.at(-1)).toContain('thimble doctor')
  await m.unmount()
})

// bug hunt C18: an orientation that both models refused
const RAW = "API Error: Opus 4.8's safeguards flagged this message. Send feedback with /feedback.\n\nDetails: `[cyber]`\n\nRequest ID: req_011CgFAKE\n\nMessage ID: msg_01FAKE"
const ORIENT_FAILED = { id: 'n5', key: 'agent:orient', kind: 'agent', text: "The orientation failed: Claude's safeguards stopped its request; rephrase or narrow the request and try again.", agent: 'Orientation', chat: 'c-orient', open: 'agent', at: '2026-10-17T04:36:58Z', acts: [{ label: 'Run again', act: 'orient-again' }] }

test("bug hunt C18: a failed orientation's notice runs it again; its panel offers `run again` with a focus field and no `stop`, its raw error under `details`", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [ORIENT_FAILED]
  w.states.agents = { rows: [{ name: 'thimble:orient', label: 'Orientation', state: 'failed', kind: 'subagent', chat: 'c-orient', role: 'orient' }], line: '', text: '' }
  w.chats['c-orient'] = {
    meta: { id: 'c-orient', kind: 'agent', role: 'orient', key: 'orient', title: 'Orientation', status: 'failed', brief: 'what stands out in the transcript?' },
    events: [
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'wc -l transcript.jsonl' } },
      { type: 'text', delta: RAW, api_error: 'refused', refusal: 'True' },
      { type: 'notice', key: 'agent:orient', kind: 'agent', text: ORIENT_FAILED.text },
      { type: 'error', message: RAW, kind: 'failed' },
    ],
  }
  await start($, w)
  // home reads the agents
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-notice-n5' }))).toContain('run againsee the orientation ›dismiss')
  await band.press({ key: 'above-notice-n5-open' })
  await w.clock.settle()
  await band.unmount()
  let pane = (await $.ui.mount(paneAt(120, 60))) as unknown as M
  let text = words(await pane.drawn())
  expect(text).toContain("× The orientation failed: Claude's safeguards stopped its request")
  expect(text).toContain('run again')
  expect(text).toContain('details')
  expect(await pane.find({ type: 'Button', key: 'agent-stop' })).toBeUndefined()
  expect(text).not.toContain('s to stop')
  expect(text).not.toContain('Request ID')
  expect(text).not.toContain('req_011CgFAKE')
  // `details` shows the raw error
  await pane.press({ key: 'agent-details' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(paneAt(120, 60))) as unknown as M
  expect(words(await pane.drawn())).toContain('Request ID: req_011CgFAKE')
  // a focus typed in the field is added to its last request (bug hunt E11); `run again` asks main to start it with its
  // last request, and stays while main is asked (the field is gone then, bug hunt E13)
  await pane.input({ key: 'make-orient-again-c-orient', text: 'only the registry steps' })
  await w.clock.settle()
  expect(w.submitted.at(-1)).toBe('Run the orientation again: call start_orientation with this brief, word for word: "what stands out in the transcript? Narrower focus for this run: only the registry steps".')
  await pane.press({ key: 'agent-again' })
  await w.clock.settle()
  expect(w.submitted.at(-1)).toBe('Run the orientation again: call start_orientation with this brief, word for word: "what stands out in the transcript?".')
  await pane.unmount()
  // the notice's own act does what `run again` does, and the notice goes
  const again = (await $.ui.mount(aboveAt(220))) as unknown as M
  await again.press({ key: 'above-notice-n5-act-0' })
  await w.clock.settle()
  expect(w.submitted.at(-1)).toBe('Run the orientation again: call start_orientation with this brief, word for word: "what stands out in the transcript?".')
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['n5'])
  await again.unmount()
})

// bug hunt E11: a focus narrows the failed orientation's question, it does not replace it
test("bug hunt E11: run again with a focus keeps the last run's brief and adds the focus; a later focus replaces the earlier one", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [{ ...ORIENT_FAILED, id: 'n7', chat: 'c-zorb' }]
  w.states.agents = { rows: [{ name: 'thimble:orient', label: 'Orientation', state: 'failed', kind: 'subagent', chat: 'c-zorb', role: 'orient' }], line: '', text: '' }
  w.chats['c-zorb'] = {
    meta: { id: 'c-zorb', kind: 'agent', role: 'orient', key: 'orient', title: 'Orientation', status: 'failed', brief: 'Which zorbs trade with the quillans, and how did the trade change?' },
    events: [{ type: 'notice', key: 'agent:orient', kind: 'agent', text: ORIENT_FAILED.text }, { type: 'error', message: RAW, kind: 'failed' }],
  }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  await band.press({ key: 'above-notice-n7-open' })
  await w.clock.settle()
  await band.unmount()
  const pane = (await $.ui.mount(paneAt(120, 60))) as unknown as M
  await pane.input({ key: 'make-orient-again-c-zorb', text: '  only the blimfen ledgers, no code ' })
  await w.clock.settle()
  expect(w.submitted.at(-1)).toBe('Run the orientation again: call start_orientation with this brief, word for word: "Which zorbs trade with the quillans, and how did the trade change? Narrower focus for this run: only the blimfen ledgers, no code".')
  await pane.unmount()
  // a second focus replaces the first; a brief without an end stop gets one; no brief: the focus is the brief
  const once = 'Which zorbs trade with the quillans? Narrower focus for this run: only the blimfen ledgers'
  expect(focusedBrief(once, 'the grelk dates')).toBe('Which zorbs trade with the quillans? Narrower focus for this run: the grelk dates')
  expect(focusedBrief(once, ' ')).toBe(once)
  expect(focusedBrief('zorb trade routes', 'the grelk dates')).toBe('zorb trade routes. Narrower focus for this run: the grelk dates')
  expect(focusedBrief('', 'the grelk dates')).toBe('the grelk dates')
})

// bug hunt E13: the focus box kept the keys after the rerun started, the panel kept the old failure, and a later `/exit`
// became the brief of a third orientation
test('bug hunt E13: after a rerun from the focus box the keys are the panel\'s again and the panel shows the new run; a slash command typed into an entry box goes to the prompt, never to main', T, async ($, on) => {
  const w = panelWorld(on)
  const BOX = 'make-orient-again-c-vell'
  w.states.home.notices = [{ ...ORIENT_FAILED, id: 'n9', chat: 'c-vell' }]
  w.states.agents = { rows: [{ name: 'thimble:orient', label: 'Orientation', state: 'failed', kind: 'subagent', chat: 'c-vell', role: 'orient' }], line: '', text: '' }
  w.chats['c-vell'] = {
    meta: { id: 'c-vell', kind: 'agent', role: 'orient', key: 'orient', title: 'Orientation', status: 'failed', brief: 'How do the vellum barges move cargo?' },
    events: [{ type: 'notice', key: 'agent:orient', kind: 'agent', text: ORIENT_FAILED.text }, { type: 'error', message: RAW, kind: 'failed' }],
  }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  await band.press({ key: 'above-notice-n9-open' })
  await w.clock.settle()
  await band.unmount()
  const asked = () => w.submitted.filter(s => s.startsWith('Run the orientation again')).length
  const look = async (focused = true) => {
    w.paneFocused = focused
    const at = paneAt(120, 60) as unknown as { props: Record<string, unknown> }
    return (await $.ui.mount({ ...at, props: { ...at.props, isFocused: focused } } as never)) as unknown as M
  }
  // `/` typed into the box goes to the prompt, and the box draws no field, so the rest of `/exit` and its Enter reach
  // the prompt
  let pane = await look()
  await pane.input({ key: BOX, text: '/', kind: 'change' })
  await w.clock.settle()
  await pane.unmount()
  expect(w.filled.join('')).toBe('/')
  pane = await look()
  expect(await pane.find({ type: 'Input', key: BOX })).toBeUndefined()
  await pane.unmount()
  // the prompt has the keys; a click gives them back, and the box is drawn with its field again
  await (await look(false)).unmount()
  pane = await look()
  expect(await pane.find({ type: 'Input', key: BOX })).toBeDefined()
  // a slash command sent whole (a paste and Enter) waits in the prompt for the Enter that runs it there
  await pane.input({ key: BOX, text: '/exit' })
  await w.clock.settle()
  await pane.unmount()
  expect(w.filled.join('')).toBe('//exit')
  expect(w.toasts.at(-1)).toContain('press Enter there')
  expect(asked()).toBe(0)
  await (await look(false)).unmount()
  // a focus typed and Enter: main is asked once; the box is gone, so the keys are the panel's: `x to close`
  pane = await look()
  await pane.input({ key: BOX, text: 'only the barge manifests' })
  await w.clock.settle()
  await pane.unmount()
  expect(asked()).toBe(1)
  expect(w.submitted.at(-1)).toContain('How do the vellum barges move cargo? Narrower focus for this run: only the barge manifests')
  pane = await look()
  let text = words(await pane.drawn())
  expect(await pane.find({ type: 'Input', key: BOX })).toBeUndefined()
  expect(text).toContain('main was asked to run it again')
  expect(text).toContain('x to close')
  expect(text).not.toContain('f for a focus')
  expect(await pane.find({ type: 'Button', key: 'hk-close' })).toBeDefined()
  await pane.unmount()
  // the new run is listed: the panel shows it in place of the failure, running, then done
  w.states.agents.rows.push({ name: 'thimble:orient', label: 'Orientation', state: 'running', kind: 'subagent', chat: 'c-vell-2', role: 'orient' })
  // its chat as the route answers it whole (`total`)
  const run2 = { meta: { id: 'c-vell-2', kind: 'agent', role: 'orient', key: 'orient', title: 'Orientation', status: 'running' }, events: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'wc -l manifests.jsonl' } }] as Record<string, unknown>[], total: 1 }
  w.chats['c-vell-2'] = run2
  w.stamps.set(`${WS}/chats/c-vell-2.json`, 5)
  await w.clock.advance(1100)
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = await look()
  text = words(await pane.drawn())
  await pane.unmount()
  expect(text).toContain('running')
  expect(text).toContain('wc -l manifests.jsonl')
  expect(text).not.toContain('The orientation failed')
  expect(text).not.toContain('main was asked')
  w.states.agents.rows[1]!.state = 'done'
  run2.meta.status = 'done'
  run2.events.push({ type: 'done', result: 'The barges move cargo in three hops.' })
  run2.total = 2
  w.stamps.set(`${WS}/chats/c-vell-2.json`, 6)
  await w.clock.advance(1100)
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = await look()
  text = words(await pane.drawn())
  await pane.unmount()
  expect(text).toContain('done')
  expect(text).not.toContain('running')
  expect(text).not.toContain('The orientation failed')
})

// bug hunt C17: a label whose records Claude's safeguards refused in part
test("bug hunt C17: a label's notice links the label (`see the label ›`) and runs it again on the records it could not label", T, async ($, on) => {
  const w = panelWorld(on)
  const id = LABEL.id
  w.states.home.notices = [{ id: 'n6', key: `label:${id}`, kind: 'label', text: `The label ${LABEL.name} couldn't label 184 of 2,064 records: Claude's safeguards refused them.`, agent: `Label: ${LABEL.name}`, chat: '', at: '2026-10-17T04:47:49Z', acts: [{ label: 'Run again on these 184', act: 'label-again', slug: id }, { label: 'See the label', act: 'label-open', slug: id }] }]
  await start($, w)
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-notice-n6' }))).toContain('run again on these 184see the label ›dismiss')
  await band.press({ key: 'above-notice-n6-act-1' })
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toContain(LABEL.name)
  await band.press({ key: 'above-notice-n6-act-0' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label-run', payload: { label: id, again: true } })
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['n6'])
  await band.unmount()
})

// bug hunt C23: main's reply Claude's safeguards stopped partway, mid add_card
const ASKED = 'Which runs failed, and why?'
const AGAIN = 'Claude\'s safeguards stopped your reply while you were adding the card "Which runs failed?", and the card was not added. Make that card again.'
const STOPPED = { id: 'n7', key: 'stopped:main', kind: 'stopped', text: "Claude's safeguards stopped main's reply partway, so the card it was making wasn't added: \"Which runs failed?\". Make the card again, or ask again in other words.", agent: '', chat: 'main', open: '', at: '2026-10-17T05:31:38Z', acts: [{ label: 'Make the card again', act: 'card-again', text: AGAIN }, { label: 'Ask again', act: 'ask-again', text: ASKED }] }

test("bug hunt C23: a stopped reply's notice puts the analyst's question back in the prompt, or asks main to make the card again", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [STOPPED]
  await start($, w)
  let band = (await $.ui.mount(aboveAt(220))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-notice-n7' }))).toContain('make the card againask againdismiss')
  await band.press({ key: 'above-notice-n7-act-1' })
  await w.clock.settle()
  expect(w.filled.at(-1)).toBe(ASKED)
  expect(w.submitted).toEqual([])
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['n7'])
  await band.unmount()
  // the same failure again, and this time the card
  w.states.home.notices = [{ ...STOPPED, id: 'n8' }]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  band = (await $.ui.mount(aboveAt(220))) as unknown as M
  await band.press({ key: 'above-notice-n8-act-0' })
  await w.clock.settle()
  expect(w.submitted.at(-1)).toBe(AGAIN)
  expect(w.acts.filter(a => a.kind === 'notice-dismiss').map(a => a.payload.id)).toEqual(['n7', 'n8'])
  await band.unmount()
})

// bug hunt H16: the stopped page's notice had only `dismiss`; its act starts the page as /thimble browser does
test("bug hunt H16: the stopped page's notice comes as its file changes, and its act starts the page as /thimble browser does", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  w.states.home.notices = [{ id: 'n9', key: 'page:stopped', kind: 'server', text: "thimble's page stopped, so thimble's tools wait for it. In your terminal: type /thimble browser to start it again.", agent: '', chat: '', at: '2026-10-17T17:11:10Z', acts: [{ label: 'start it again', act: 'page-start' }] }]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-notice-n9' }))).toContain('start it againdismiss')
  await band.press({ key: 'above-notice-n9-act-0' })
  await w.clock.settle()
  expect(w.pressed).toEqual([['/tree/plugin/bin/thimble', 'open', '--session', 's1', '--cwd', CWD, '--ref', 'home', '--json']])
  await band.unmount()
})

test('bug hunt F12: the notice of a sign-in from an earlier session shows once, in that session: a new one draws no row for it and posts no toast, even when the band draws before home is read', T, async ($, on) => {
  const w = panelWorld(on)
  // signed in at 12:39 the day before this session began (the test's clock starts on 2026-09-21); a sign-in during
  // this session still shows
  const earlier = { id: 'si1', key: 'signin:new:b1', kind: 'sign-in', text: "A browser signed in to thimble's page at 12:39.", agent: '', chat: '', at: '2026-09-20T12:39:00Z', acts: [{ label: 'Sign it out', act: 'sign-out', slug: 'b1' }] }
  const old = { ...NOTICE, id: 'n0', text: 'An old failure.', at: '2026-09-20T12:00:00Z' }
  w.states.home.notices = [earlier, old]
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const first = (await $.ui.mount(aboveAt(160))) as unknown as M
  await first.unmount()
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(160))) as unknown as M
  expect(await m.find({ type: 'Box', key: 'above-notice-si1' })).toBeUndefined()
  expect(JSON.stringify(await m.drawn())).not.toContain('signed in')
  await m.unmount()
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(w.toasts.filter(t => /signed in|An old failure/.test(t))).toEqual([])
  // a sign-in in this session shows, with one toast
  const now = { ...earlier, id: 'si2', key: 'signin:new:b2', text: "A browser signed in to thimble's page at 09:15.", at: '2026-10-16T09:15:00Z', acts: [{ label: 'Sign it out', act: 'sign-out', slug: 'b2' }] }
  w.states.home.notices = [now, earlier, old]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  const after = (await $.ui.mount(aboveAt(160))) as unknown as M
  expect(words(await after.find({ type: 'Box', key: 'above-notice-si2' }))).toContain('at 09:15.')
  await after.unmount()
  expect(w.toasts.filter(t => /signed in/.test(t))).toEqual(["A browser signed in to thimble's page at 09:15."])
})
