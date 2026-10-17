// thimble's terminal UI: every hook of the term/ files (thimble.ts, the agent bridge and file guard, is the other half
// of the one hooks module, plugin/hooks/register.ts). It loads in every Claude Code session and stays quiet until
// thimble is on in it (activate.ts): before that every hook passes through, except the path test of Read and Bash calls
// that turns thimble on at the first data-file read, and `/thimble`. It registers no model tools or agents; what it
// draws comes from `thimble state`, and every change it makes goes through `thimble act` (hooks/data.ts). What main's
// chat drew under its rows is kept in the workspace's terminal/chat.json for a resumed session (hooks/kept.ts).
//
// What it does once thimble is on (its look is SPEC.md's "The visual system"):
//   - delivers thimble's guide to Claude once per need: with the call that turned thimble on, with a prompt, with
//     `/thimble`, after a compaction and after /clear, and marks it sent once the row that carries it is stored
//   - tracks what Claude's tool calls read of the data files and sends it at each turn's end (tracker.ts)
//   - main's replies on the mod's grid, each citation a link, red when its place does not hold its value (reply.tsx);
//     a passage a check commented on tinted in the check's color, with a flag in the margin
//   - each card a turn of main added or changed, once, under the turn's last reply, in its last state, its takeaway
//     under it, a ↗ on its border row in fullscreen; no hex id, and Claude Code's tool groups left folded
//   - the rows above the prompt (band.tsx) and one panel (panel.tsx): home, a card, a citation's place, the threads, a
//     label, a document, the files, an agent, and the views views.ts registers
//   - side threads: the blue "?" beside a passage or a card, or a selection's "ask"; a `↳ thread` row under main's
//     latest row when an answer comes in while the panel shows something else, and a blue ↳ beside the passage asked
//     about. A right-click does what a click does: there is no menu
//   - `/thimble` turns thimble on and opens the home panel, with no model turn
//   - keeps the feature switches in step between /config and thimble's config (settings.ts)
// It hides main's end token, `(shown in the dashboard)`, as the browser does.
//
// `$` goes only into cxOf (ctx.ts), which builds the context the other files take.
import { atom, read, update } from 'claude-code'
import type { Register, RenderElement, ResolveInput } from 'claude-code'

import type { Ctx } from './ctx'
import { cxOf } from './ctx'
import { act as actOn, readState } from './data'
import type { Sent } from './gestures'
import { SPIN, streamLink, streamStep, streaming } from './cite'
import type { StreamLook, Streaming } from './cite'
import type { CardData } from './draw'
import { cardWords, cid, citeSpans, citations, clean, clip, cut, embeddedCards, labelRef, needsDrawing, quoted } from './lib'
import type { AnswerComment, CiteRow } from './contracts'
import { lineWidth } from './draw'
import { cardsOfCall, docsOf, forkDescription, labelsOf, namedForks, namedThreads, noteLines, reportOf, runIds, runShown, saysWriter, threadOf, withoutEnd, withoutLines, withoutNotes, withoutToldThreads, withoutWriterLines } from './model'
import { keepLast, keepRow } from './kept'
import { linesMessage, onListClick } from './lines'
import { ANSWER_ELEMENT, RELAY, drawPanel, fieldMessage, focusedField, hasList, homeViews, onGesture, openAsk, openCard, openCite, openFile, openLabel, openThread, openView, relayMove, relayMoveKey, scrollPending, viewWheelAt, wheelWindow } from './panel'
import type { PaneEvent } from './panel'
// the file browser and a file, drawn by a module of their own (panel.tsx drawsView, term.ts loadsView)
import { MARGIN, chipOf, drawCards, drawReply, placeUrl, toolWords } from './reply'
import { COLORS } from './paint'
import { isAnchor, signalEnd, signalQuestion } from './signal'
import type { AppendedRow } from './signal'
import { PANEL, cardDeleted, cardMade, classicScreen, keepKeys, keysBack, liveCards, loadCards, navOrigin, noteScreen, openHome, openPanel, paneTitle, panelColumns, placedLater, queueCitations, readSurface, rt, surfaceValue, takeKeys, threadsNow } from './term'
import { turns } from './turns'
import { openSection, registerBand } from './band'
import { registerPanelViews } from './views'
import { closeView, openViewState, sendEvent, viewFault, viewMessage } from './viewhost'
import { LOAD_TOOL, act, activateNow, appendGuide, bounded, conversationEnded, deliverStarts, deliveryLost, followConversation, guideAfterCompact, isActive, owedGuide, preScope, resetActivation, restoreFromMarker, rowStored, sawLoadThimble } from './activate'
import { onFlip, pushChange, resetSettings, setOptions, syncSoon } from './settings'
import { callDone, checkName, ownNotice } from '../thimble'
import { factsHeld, factsOf, flushFacts, keepFacts, resetTracker } from './tracker'
import { openInBrowser, remoteReply } from './offramp'
import { openChecks } from './checksview'
import { answerItems, citeCounts, openCitations } from './citesview'
import { openCoverage } from './coverageview'
import { featureOn } from './settings'
import { setTheme } from './paint'


/** /thimble's description and argument hint (the command.describe hook). */
export const THIMBLE_DESCRIPTION =
  "Opens thimble's panel in this terminal. `/thimble browser` opens the browser workbench; `coverage`, `citations`, `checks`, `threads`, `labels`, `cite <n>`, `card <n>`, `files <path[:line]>` and `documents` open those."
export const THIMBLE_ARGS = '[browser | coverage | citations | checks | threads | labels | cite <n> | card <n> | files <path[:line]> | documents]'
/** What `/thimble` says (the model reads it too; logged in PROMPT-CHANGES.md): thimble is on, its panel is open, and how
 *  to reach the browser workbench. */
export const HOME_LINE = 'thimble is on in this folder. Its panel is open in the terminal; /thimble browser opens the browser workbench.'
/** The /thimble arguments the skill answers (fresh, restore, status, fix, feedback): the mod passes them on. */
const SKILL_ARGS = new Set(['fresh', 'restore', 'status', 'fix', 'feedback'])

// the text Claude Code stores as the reply of a turn that ended with none (its `<synthetic>` model's)
const SYNTHETIC_RE = /^\s*No response requested\.\s*$/
const THIMBLE_TOOL = /^mcp__(plugin_thimble_thimble|thimble-[a-z-]+)__/ // main's shim's tools, and an agent's own shim's
// what Claude Code's row of a thimble event's wake-up says: the waker hook's rewakeSummary (plugin/hooks/hooks.json)
const REWAKE_SUMMARY = 'thimble'
// a message of another agent's as main reads it (a subagent's hand-back)
const AGENT_MESSAGE = /<agent-message from="([^"]+)"/
// how long a check's dropped hand-back waits for its run's record (checkDone)
const CHECK_READ_MS = 5000
const CARD_TOOL = /^mcp__plugin_thimble_thimble__(add_card|edit_card|apply_label)$/
const DELETE_TOOL = /^mcp__plugin_thimble_thimble__(delete_card|delete_cell)$/
const VIEW_TOOL = /^mcp__plugin_thimble_thimble__propose_view$/

/** Why a check's hand-back is dropped, which Claude Code shows in its row for the drop: what the check did, by the record of
 *  the run its agent ran (`thimble state checks`): `Judgment calls added 2 comments`, `Judgment calls found nothing to
 *  flag`, or `Judgment calls finished` when the record cannot be read in time. */
async function checkDone(cx: Ctx, agentId: string, name: string): Promise<string> {
  const got = rt.sc ? await bounded(cx, readState(cx, rt.sc, 'checks'), CHECK_READ_MS) : null
  const runs = got?.ok && Array.isArray(got.value) ? got.value.flatMap(c => Object.values((c as { runs?: object } | null)?.runs ?? {})) : []
  const n = (runs.find(r => (r as { agent_id?: unknown } | null)?.agent_id === agentId) as { comments?: unknown } | undefined)?.comments
  if (typeof n !== 'number') return `${name} finished`
  return n === 0 ? `${name} found nothing to flag` : `${name} added ${n} comment${n === 1 ? '' : 's'}`
}

/** The text of a tool's result as the transcript holds it: a string, or content blocks. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output) ? output : (output as { content?: unknown } | undefined)?.content
  return Array.isArray(blocks) ? blocks.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
}
const paneTurns = turns()

// the state values this file reads and writes itself (types/index.d.ts; ctx.ts cxOf has the rest): a module names a
// value by literals in the file that reads it
const TURN_CARDS = { plugin: 'thimble', key: 'turnCards' } as const
const THREAD_ROWS = { plugin: 'thimble', key: 'threadRows' } as const
const ANSWERS = { plugin: 'thimble', key: 'answers' } as const
const VIEW_ROWS = { plugin: 'thimble', key: 'viewRows' } as const
const panelA = { plugin: 'thimble', key: 'panel' } as const
const pendingRef = { plugin: 'thimble', key: 'pending' } as const
const panelTickRef = { plugin: 'thimble', key: 'panelTick' } as const
const panelTickA = atom(panelTickRef, 0)

/** `/thimble <what>`, a keyboard way to what the chat and the panel draw: `browser` (the browser workbench; `open`
 *  too), `coverage`,
 *  `citations`, `checks`, `threads`, `labels`, `cite [n]` (the n-th citation of the last reply), `card [n|id]` (the n-th card of
 *  the last turn, or a card by its id), `files <path[:line]>`, `documents`. What it says, or null for plain `/thimble`
 *  (home). */
async function thimbleCommand(cx: Ctx, args: string): Promise<string | null> {
  const [what = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
  switch (what.toLowerCase()) {
    case '':
      return null
    case 'browser':
    case 'open': {
      // what happened, in plain words: where no browser opens (SSH, no display), what to run and how to get the link
      // (bug hunt F11)
      const how = await openInBrowser(cx, 'home')
      const links = await cx.links()
      if ((how === 'remote' || how === 'again') && links) return remoteReply(links, classicScreen())
      if (how === 'failed') return "thimble: thimble's page did not open: the notice above the prompt says why and how to fix it"
      return "thimble: opening thimble's page in the browser"
    }
    case 'coverage':
      await openCoverage(cx, arg || undefined)
      return 'thimble: the Coverage view is open'
    case 'citations':
      await openCitations(cx)
      return 'thimble: the Citations view is open'
    case 'checks':
      await openChecks(cx)
      return 'thimble: the Checks view is open'
    case 'threads': {
      await openPanel(cx, { view: 'threads', title: 'Threads' })
      return `thimble: ${plural((await cx.threads()).length, 'side thread')}`
    }
    case 'labels': {
      // the thimble line's `labels` by keys, for a screen that takes no clicks (bug hunt F1)
      await openSection(cx, 'labels')
      const got = await surfaceValue(cx, 'labels')
      return `thimble: ${plural(got?.ok ? labelsOf(got.value).length : 0, 'label')}`
    }
    case 'documents':
    case 'docs':
    case 'reports': {
      await readSurface(cx, 'docs', 'docs')
      const got = await surfaceValue(cx, 'docs')
      await openPanel(cx, { view: 'docs', title: 'Documents' })
      return `thimble: ${plural(got?.ok ? docsOf(got.value).length : 0, 'document')}`
    }
    case 'cite': {
      const cs = citations(rt.lastReply)
      const n = Number(arg)
      if (!cs.length) return 'thimble: the last reply cites nothing'
      if (!Number.isInteger(n) || n < 1 || n > cs.length) return `thimble: the last reply has ${plural(cs.length, 'citation')}: \`/thimble cite <1-${cs.length}>\` opens one`
      const c = cs[n - 1]!
      await openCite(cx, c.ref, c.display)
      return `thimble: citation ${n} of ${cs.length}`
    }
    case 'card': {
      const ids = rt.lastCards
      const n = Number(arg)
      if (arg && !Number.isInteger(n)) {
        const id = arg.replace(/^(?:card|cell):/, '')
        await loadCards(cx, [id])
        if (!(await cx.card(id))?.data) return 'thimble: no such card in this workspace'
        await openCard(cx, id)
        return 'thimble: the card is open'
      }
      if (!ids.length) return 'thimble: the last turn made no card'
      if (!Number.isInteger(n) || n < 1 || n > ids.length) return `thimble: the last turn has ${plural(ids.length, 'card')}: \`/thimble card <1-${ids.length}>\` opens one`
      await openCard(cx, ids[n - 1]!)
      return `thimble: card ${n} of ${ids.length}`
    }
    case 'files': {
      // the terminal has no file browser (Matt, 10-16): Coverage lists the files; a path opens its lines at a place
      if (!arg) {
        await openCoverage(cx)
        return 'thimble: Coverage lists the files; `/thimble files <path[:line]>` opens one at a line'
      }
      const m = /^(.*?)(?::(\d+))?$/.exec(arg)
      const path = (m?.[1] ?? arg).replace(/^\.\//, '')
      const line = m?.[2] ? Number(m[2]) : undefined
      await openFile(cx, path, line ? Math.max(1, line - 5) : 1, line)
      return `thimble: ${path}${line ? ` line ${line}` : ''} is open`
    }
    default:
      return `thimble: \`/thimble\` opens home; \`/thimble browser\` opens the browser; \`coverage\`, \`citations\`, \`checks\`, \`threads\`, \`labels\`, \`cite [n]\`, \`card [n]\`, \`files <path[:line]>\` and \`documents\` open those`
  }
}

// a text block as Claude Code was handed it while it streamed -> as the model wrote it
const asWritten = new Map<string, string>()

/** The part of a turn that is its answer: the last that cites or embeds a card, else the last with text. Earlier parts
 *  are what main wrote while it worked ("Reading the files…"). */
function answerPart(parts: { uuid: string; text: string }[][]): { uuid: string; text: string }[] | undefined {
  const full = parts.filter(p => p.some(r => r.text.trim()))
  return [...full].reverse().find(p => needsDrawing(p.map(r => r.text).join('\n\n'))) ?? full.at(-1)
}

function hasText(content: unknown): boolean {
  return Array.isArray(content) && content.some(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && String((b as { text?: unknown }).text ?? '').trim() !== '')
}

/** The rows a side thread's answer leaves under a row of main's chat (signal.ts, SPEC.md "Main's chat"), one
 *  blank row above the first: `↳` at column 0 and its words at 2, dim (`thread · "<the turn's question>" · answered`,
 *  `failed` in red), `new` in green until it is read; a press on the question opens the thread. Each turn once. */
async function signalRows(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns: number } }): Promise<RenderElement | null> {
  const rows = await cx.threadRows(e.requestId)
  if (!rows.length) return null
  const { Box, Text, Button } = cx.els(e)
  const threads = await cx.threads()
  const seen = new Set<string>()
  const out: RenderElement[] = []
  const n = Math.max(16, Math.min(60, (e.viewport?.columns ?? 100) - 30))
  for (const s of rows) {
    const k = `${s.thread}:${s.turn}`
    if (seen.has(k)) continue
    seen.add(k)
    const row = threads.find(x => x.id === s.thread)
    const tt = await cx.thread(s.thread)
    const th = tt?.events.length ? threadOf(tt.meta, tt.events) : null
    const label = row?.anchorText || (row?.anchor ? await anchorName(cx, row.anchor) : '') || row?.title || 'the side thread'
    const q = th ? signalQuestion({ turns: th.turns, label }, s.turn, n) : quoted(clip(row?.question || row?.title || label, n))
    const end = th ? signalEnd(th, s.turn) ?? 'answered' : 'answered'
    // `new` while the thread holds an answer the analyst has not opened (thimble's `unread`), on its latest answer's row
    const latest = th ? th.turns.map((x, i) => (x.state === 'done' ? i + 1 : 0)).reduce((a, b) => Math.max(a, b), 0) : s.turn
    const fresh = Boolean(row?.unread) && s.turn >= latest
    out.push(
      <Box key={`signal-${k}`} flexDirection="row" {...(out.length ? {} : { marginTop: 1 })}>
        <Text dimColor>{'↳ '}</Text>
        <Text dimColor>{'thread · '}</Text>
        <Button key={`signal-open-${s.thread}`} label={q} plain dimColor onPress={() => openThread(cx, s.thread)} />
        {end === 'failed' ? <Text color={COLORS.problem}>{' · failed'}</Text> : <Text dimColor>{' · answered'}</Text>}
        {fresh && end !== 'failed' ? <Text color={COLORS.fresh}>{' · new'}</Text> : null}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}

/** What a thread's anchor names, in words: a card by its question, a citation's place in words. */
async function anchorName(cx: Ctx, anchor: string): Promise<string> {
  const id = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(anchor)?.[1]
  if (id) {
    const q = ((await cx.card(id))?.data as CardData | null | undefined)?.question
    return q ? cardWords(q) : 'a card'
  }
  return anchor
}

/** An Agent call's stored result with a thread's fork named by the thread's first question where its `prompt` or
 *  `description` names the fork's slug (`thread:<slug>`, what ctrl+o shows under `Prompt:`); the result itself when it
 *  names none. */
function forkOutput(output: unknown, threads: Parameters<typeof namedForks>[1]): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const o = output as Record<string, unknown>
  const named = (v: unknown) => (typeof v === 'string' && /\bthread:/.test(v) ? namedForks(v, threads) : v)
  const prompt = named(o.prompt)
  const description = named(o.description)
  return prompt === o.prompt && description === o.description ? output : { ...o, prompt, description }
}

/** A Bash command that runs `thimble-run`, as its row shows it (model.ts runShown), the cards it names by their
 *  questions as read. */
async function runWords(cx: Ctx, command: string): Promise<string> {
  const questions = new Map<string, string>()
  for (const id of runIds(command)) {
    const q = ((await cx.card(id))?.data as CardData | null | undefined)?.question
    if (q) questions.set(id, q)
  }
  return runShown(command, id => questions.get(id))
}

/** The `↳ view` rows under a row of main's chat (SPEC.md, "Main's chat"): a view main proposed, `↳` dim at 0,
 *  `view · <name> · building|built|proposed` dim, `failed` in red, then `new` in green once built and not yet opened;
 *  a press on its name opens its line in the panel. */
async function viewRowsEl(cx: Ctx, e: ResolveInput & { requestId: string }): Promise<RenderElement | null> {
  const slugs = await cx.viewRows(e.requestId)
  if (!slugs.length) return null
  const { Box, Text, Button } = cx.els(e)
  const views = await homeViews(cx)
  const out: RenderElement[] = []
  for (const slug of [...new Set(slugs)]) {
    const v = views.find(x => x.slug === slug)
    const state = v?.state ?? 'proposed'
    out.push(
      <Box key={`view-row-${slug}`} flexDirection="row" {...(out.length ? {} : { marginTop: 1 })}>
        <Text dimColor>{'↳ view · '}</Text>
        <Button key={`view-open-${slug}`} label={v?.name ?? slug} plain dimColor onPress={() => openView(cx, slug, v?.name ?? slug)} />
        {state === 'failed' ? <Text color={COLORS.problem}>{' · failed'}</Text> : <Text dimColor>{` · ${state === 'built' ? 'built' : state === 'building' ? 'building' : 'proposed'}`}</Text>}
        {v?.fresh ? <Text color={COLORS.fresh}>{' · new'}</Text> : null}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}

/** The footer under a turn's answer (SPEC.md, "Main's chat"; MATT-NOTES "Classic display: no new row"), one blank row
 *  under it at column 2: `N citations · N cards` dim, ` · ◌ checking N` dim while checks run on its citations, then
 *  ` · N failed` in red for the ones that failed for good (none when 0; a press opens the panel's Citations view), then
 *  `ask about this answer ›`. The citations are those drawn in the answer, its words' and its cards' takeaways', a chip
 *  too, counted as the thimble line and the Citations view count them (citesview.tsx answerItems). The facts are cut
 *  first; the counts stay whole. */
async function footerEl(cx: Ctx, e: ResolveInput & { requestId: string }): Promise<RenderElement | null> {
  const ans = await cx.answer(e.requestId)
  if (!ans) return null
  const { Box, Text, Button } = cx.els(e)
  const cards = liveCards(ans.cards)
  const counts = citeCounts(await answerItems(cx, ans.text, cards))
  // "Citation marks" off: nothing checks them
  const marks = featureOn('citationMarks')
  const checking = marks ? counts.pending : 0
  const failed = marks ? counts.bad : 0
  const num = (n: number) => n.toLocaleString('en-US')
  const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? '' : 's'}`
  const facts = [...(counts.all ? [plural(counts.all, 'citation')] : []), ...(cards.length ? [plural(cards.length, 'card')] : [])].join(' · ')
  return (
    <Box key={`footer-${e.requestId}`} marginTop={1} marginLeft={MARGIN} flexDirection="row" columnGap={2}>
      <Box flexShrink={1} flexDirection="row">
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{facts}</Text>
        </Box>
        {checking ? (
          <Box flexShrink={0}>
            <Text dimColor>{` · ${SPIN} checking ${num(checking)}`}</Text>
          </Box>
        ) : null}
        {failed ? (
          <Box flexShrink={0} flexDirection="row">
            <Text dimColor>{' · '}</Text>
            <Button key={`failed-${e.requestId}`} plain onPress={() => openCitations(cx)}>
              <Text color={COLORS.problem}>{`${num(failed)} failed`}</Text>
            </Button>
          </Box>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Button key={`ask-answer-${e.requestId}`} label="ask about this answer ›" plain onPress={() => openAsk(cx, { kind: 'sentence', text: withoutNotes(ans.text).slice(0, 6000), label: 'this answer' }, { element: ANSWER_ELEMENT })} />
      </Box>
    </Box>
  )
}

/** The line under the row that says a writer's end (main's `↳ The writer finished …`, the first row that says it): the
 *  document it wrote, a press away in the browser workbench, where it is read whole, edited, and its figures and history
 *  shown; the terminal reads documents only (Matt, 10-16). The writer's document by its name (`writer: <slug>`), else
 *  the one written last, as the documents were read when the writer ended (band.tsx noteWriters); its slug alone when
 *  they were not read. None while the writer writes, or after it failed or stopped. */
async function writtenEl(cx: Ctx, e: ResolveInput & { requestId: string }, text: string): Promise<RenderElement | null> {
  if (!saysWriter(text)) return null
  const chat = rt.writerOf.get(e.requestId)
  const agents = (await cx.agents()) ?? []
  const agent = chat ? agents.find(a => a.chat === chat) : agents.filter(a => a.role === 'writer').sort((a, b) => a.started.localeCompare(b.started)).at(-1)
  if (agent?.state === 'running' || /fail|error|stop/i.test(agent?.state ?? '')) return null
  // drawing reads only: the documents as read when the writer ended
  const got = await surfaceValue(cx, 'docs')
  const docs = got?.ok ? docsOf(got.value) : []
  const named = (agent?.label ?? '').replace(/^writer:\s*/i, '').trim()
  const written = docs.filter(d => d.status !== 'generating' && d.status !== 'error')
  const doc = (named ? written.find(d => d.slug === named || d.title === named) : undefined) ?? written.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0] ?? (named && /^[\w-]+$/.test(named) && !got ? { slug: named, title: named } : undefined)
  if (!doc) return null
  const { Box, Text, Button } = cx.els(e)
  return (
    <Box key={`written-${e.requestId}`} marginLeft={MARGIN} marginTop={1} flexDirection="row">
      {/* the label never shrinks: a narrow column wraps the link, not `document` (bug hunt 0.9.0, B13) */}
      <Box flexShrink={0}>
        <Text dimColor>{'↳ document '}</Text>
      </Box>
      <Box flexShrink={1}>
        <Button key={`written-open-${e.requestId}`} label={`${quoted(clip(clean(doc.title), 60))} · read and edit it in the browser ↗`} plain onPress={() => void openInBrowser(cx, `report:${doc.slug}`)} />
      </Box>
    </Box>
  )
}

/** A row of main's chat without its `↳ The writer …` line when an earlier row said that writer run's end (the run: the
 *  writer whose chat began last when the row was first drawn, kept with the row so a resumed session decides the same). */
async function withoutSaidWriter(cx: Ctx, row: string, text: string): Promise<string> {
  if (!row || !saysWriter(text)) return text
  let chat = rt.writerOf.get(row)
  if (!chat) {
    // the writer that began last: its chat's start, the newest
    const latest = (await cx.agents()).filter(a => a.role === 'writer' && a.chat).sort((a, b) => a.started.localeCompare(b.started)).at(-1)
    if (!latest) return text
    chat = latest.chat
    rt.writerOf.set(row, chat)
    if (!rt.writerSaid.has(chat)) rt.writerSaid.set(chat, row)
    if (rt.sc) await keepRow(cx, rt.sc.ws, row, { writer: { chat, first: rt.writerSaid.get(chat) === row } })
  }
  return rt.writerSaid.get(chat) === row || !rt.writerSaid.has(chat) ? text : withoutWriterLines(text)
}

/** A prompt of main's: when it reports on a subagent run (model.ts reportOf), one of the reports main answers next, and
 *  whether it is the run's second report after a first that main answered with a `↳` line. Reports that come before
 *  main's next text row are answered together, also when another prompt comes between: a task notification that comes
 *  right after main answered the run's hand-back may start no turn of its own, and main then answers it atop its reply
 *  to the analyst's next prompt (live check on 0.7.0). */
function heard(text: string): void {
  const r = reportOf(text)
  if (!r) return
  rt.answering ??= { reports: [] }
  const first = rt.reports.get(r.agent)
  let again = false
  if (first && first.kind !== r.kind && !first.paired) {
    first.paired = true
    again = first.said
  } else rt.reports.set(r.agent, { kind: r.kind, said: false, paired: false })
  rt.answering.reports.push({ agent: r.agent, again })
}

/** Main's first text row after reports, which answers them: which of its `↳` lines are said and which repeat a run's
 *  end said already (live QA on 0.7.0: `↳ The view builder finished` once for its hand-back and again for Claude Code's
 *  task notification, which the browser's chat hides). For one report its lines answer it; for several, main writes a
 *  line for each in their order, so where the row has one line per report each line answers its report; where that is
 *  unclear, no line is hidden. Later rows answer something else, such as a fork that returned. */
async function noteAnswer(cx: Ctx, row: string, text: string): Promise<void> {
  const a = rt.answering
  if (!a) return
  rt.answering = null
  const lines = noteLines(text)
  const one = a.reports.length === 1
  const mapped = !one && lines.length === a.reports.length
  if (!lines.length) return
  a.reports.forEach(r => {
    const first = rt.reports.get(r.agent)
    if (!r.again && (one || mapped) && first && !first.paired) first.said = true
  })
  const hide = one ? (a.reports[0]!.again ? lines : []) : mapped ? lines.filter((_, i) => a.reports[i]!.again) : []
  if (!hide.length) return
  rt.repeats.set(row, [...new Set([...(rt.repeats.get(row) ?? []), ...hide])])
  if (rt.sc) await keepRow(cx, rt.sc.ws, row, { repeat: rt.repeats.get(row)! })
}

/** A row of main's chat with what thimble-term draws under it: the turn's cards (when no reply row carries them) and
 *  the side threads' rows. */
async function underRow(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns: number } }, next: () => Promise<RenderElement>): Promise<RenderElement> {
  const ids = liveCards(await cx.turnCards(e.requestId))
  const told = await signalRows(cx, e)
  const views = await viewRowsEl(cx, e)
  if (!ids.length && !told && !views) return next()
  const { Box } = cx.els(e)
  const cards = await drawCards(cx, e, ids, (e.viewport?.columns ?? 100) - 2, t => openAsk(cx, t), id => openThread(cx, id))
  return (
    <Box flexDirection="column">
      {await next()}
      {cards}
      {told}
      {views}
    </Box>
  )
}

/** The text a stored row holds: its text blocks, and a tool result's text. */
function rowText(message: { content?: unknown } | undefined): string {
  const blocks = Array.isArray(message?.content) ? (message.content as { type?: unknown; text?: unknown; content?: unknown }[]) : []
  return blocks.map(b => (typeof b?.text === 'string' ? b.text : b?.type === 'tool_result' ? resultText(b.content) : '')).join('\n')
}

/** Whether a classic (main screen) answer tints late comments (LC9): Claude Code reprinted the whole transcript when a
 *  row taller than the screen changed, so a tall answer keeps no tint on the main screen and its comments show in the
 *  panel and the summary line only. */
const TALL_TINT_CLASSIC = false

/** The open comments of the checks on this row (`requestId`), each located in the text drawn; none with "Checks" off,
 *  and none on the main screen for an answer taller than the screen (TALL_TINT_CLASSIC). */
async function commentsFor(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns?: number; rows?: number; isFullscreen?: boolean } }, text: string, cols: number, cards: number): Promise<AnswerComment[]> {
  if (!featureOn('checks') || !text.trim()) return []
  const mine = (await cx.answerComments()).filter(c => c.row === e.requestId && c.status === 'open')
  if (!mine.length) return []
  if (!TALL_TINT_CLASSIC && e.viewport && e.viewport.isFullscreen === false && answerRows(text, cols) + cards * 12 > (e.viewport.rows ?? Infinity)) return []
  return mine
}

/** About how many rows a reply's text takes at `cols` columns. */
function answerRows(text: string, cols: number): number {
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(lineWidth([{ s: l }]) / Math.max(10, cols))), 0)
}

/** The chat citations of an answer kept for the panel's Citations view, by their row (C13 citeIndex), the newest 2000. */
async function indexCitations(cx: Ctx, text: string, row: string): Promise<void> {
  if (!row) return
  const at = await cx.now()
  const have = await cx.citeIndex()
  const known = new Set(have.map(r => `${r.id}|${r.row}`))
  const add: CiteRow[] = citations(text)
    .filter(c => !labelRef(c.ref))
    .map(c => ({ id: cid(c.raw), raw: c.raw, display: c.display, ref: c.ref, row, at }))
    .filter(r => !known.has(`${r.id}|${r.row}`))
  if (add.length) await cx.setCiteIndex([...have, ...add].slice(-2000))
}

export const register: Register = (on, options) => {
  // the /config values of the seven switches (settings.ts): a /config change reloads the module with new ones; a flip of
  // labels or checks changes the guide, which is then owed if thimble says so
  setOptions(options)
  onFlip.run = (before, after) => {
    if (before && (before.labels !== after.labels || before.checks !== after.checks) && act.owed === false) act.owed = null
  }
  // a click on an empty part of a list hands the keys back to the pane (term.ts takeKeys)
  onListClick(takeKeys)
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const started = await next(e)
    const cx = cxOf($)
    // a fresh session, or a fresh copy of the module: nothing on, nothing held
    resetActivation(e)
    resetSettings()
    resetTracker()
    rt.sc = null
    rt.timers = false
    rt.turn = null
    // when this conversation began: its first launch, so a thread asked before a `--continue` is not an earlier one's
    rt.startedAt = await $.session
      .usage()
      .then(u => u.startedAt)
      .catch(() => $.clock.now())
      .catch(() => Date.now())
    // the `thimble` command's start (THIMBLE_OPEN), `thimble -c` included
    const launched = (await cx.env('THIMBLE_OPEN').catch(() => undefined)) === '1'
    // the session's values outlive a module reload but not the process: none yet is a new `claude` process
    const reloaded = (await cx.activated()) !== null
    // a module reload (a /config change) or a resumed session where thimble is on: restored quietly from the
    // session's marker, with no push and the guide only if it is owed
    if (await restoreFromMarker(cx)) {
      // a pane that waited undrawn before the module loaded again (its state is the session's)
      rt.waiting = (await cx.pending()) !== null
      // `thimble -c` opens the browser on home as `thimble` does, which starts the server and moves the continued
      // session to it (bug hunt H8); a module reload in the same process opens nothing again
      if (launched && !reloaded) await openInBrowser(cx, 'home')
      return started
    }
    // the `thimble` command: thimble on at once, and the browser opened on home. Neither start calls load_thimble, which
    // Claude Code would ask about in Manual mode before the person typed anything (bug hunt F3): the first prompt
    // carries the guide
    if (launched) {
      const turned = await activateNow(cx, 'launcher', false)
      if (turned.ok) await openInBrowser(cx, 'home')
      return started
    }
    // as a regular Claude Code plugin: on from the start of every interactive session where the plugin is enabled
    // (the owner, 10-16 22:45); a folder thimble refuses (the home folder, `/`) stays off without a notice
    if (act.interactive && act.surface === 'terminal') {
      act.refusedSaid = true
      await activateNow(cx, 'command', false)
      act.refusedSaid = false
    }
    return started
  })

  // /thimble: thimble on in this folder (a refused folder is asked again: the person asked), the home panel or the view
  // its argument names, with no model turn; the guide goes with its answer when it is owed. The skill's own arguments
  // (fresh, restore, status, fix, feedback) go to the skill.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'thimble:thimble' && e.command !== 'thimble') return next(e)
    const args = String(e.args ?? '').trim()
    if (SKILL_ARGS.has((args.split(/\s+/)[0] ?? '').toLowerCase())) return next(e)
    const cx = cxOf($)
    if (e.presentation?.columns > 0) rt.termColumns = e.presentation.columns
    noteScreen(undefined, e.presentation?.isFullscreen)
    if (!isActive()) {
      const turned = await activateNow(cx, 'command')
      if (!turned.ok) return { text: `thimble: ${turned.error ?? 'thimble could not turn on in this folder'}` }
    }
    await followConversation(cx)
    await navOrigin(cx, false)
    const said = await thimbleCommand(cx, args)
    // the guide goes into main's conversation as a hidden row now: a command's `context` did not reach the model in
    // 2.1.301, so a /thimble before the first question left main with no guidance and its answers cited nothing
    const guide = await owedGuide(cx)
    if (guide) await appendGuide(cx, guide)
    if (said !== null) return { text: said }
    await openHome(cx)
    return { text: HOME_LINE }
  })
  // /thimble as the typeahead and /help describe it once thimble is on: what it does here
  on('command.describe', async ($, e, next) => {
    if (!rt.sc || (e.command !== 'thimble:thimble' && e.command !== 'thimble')) return next(e)
    return next({ ...e, description: THIMBLE_DESCRIPTION })
  })

  // the feature switches: a person's /config change of a thimble row reaches thimble's config at once (settings.ts),
  // from `e.value` (this fires before the write, while `options` holds the old value); before thimble is on it waits
  // for the sync at activation. A theme change repaints the cards in that theme's palette and the passages' tints.
  on('config.set', { key: /^thimble\.|^theme$/ }, async ($, e, next) => {
    if (e.key === 'theme') {
      const r = await next(e)
      if (!r.deny) setTheme(await cxOf($).theme(r.value))
      return r
    }
    if (e.origin.kind === 'composer' && isActive()) await pushChange(cxOf($), e.key, e.value)
    return next(e)
  })

  // a prompt carries thimble's guide when it is owed (after /clear, a switch that changed it, a resumed session).
  // A check's hand-back never reaches main: thimble shows its comments as the passage's tint and flag (SPEC-v2 J7).
  // thimble's hand-back hook (plugin/bin/.thimble-watch --handback) takes the report of a check's or a model call's agent
  // that thimble's module started and refuses the call, so it never enters main's queue and Claude Code prints no row.
  // One that still arrives (the hook failed, or main's own Agent call started the check) is dropped here, as it enters,
  // since Claude Code queues a hand-back for main with no session.receive: the reason says what the check did (the owner,
  // 10-17), or for a model call's agent, whose answer went to thimble through its tools, the line the server gave its
  // start (`thimble checked the card "…"`, backend/app/agent_call.py). Claude Code's task notification of such an agent
  // is dropped the same way (ownNotice): it too is queued with no session.receive (enqueueAgentNotification), and a
  // check's notice that it waits on its own background work, or ended with no report, is about thimble's plumbing (bug
  // hunt E10); .thimble-watch --foreground keeps a check from starting such work, so none is sent
  on('prompt.submit', async ($, e, next) => {
    const from = e.origin.kind === 'peer' ? AGENT_MESSAGE.exec(e.text)?.[1] : e.origin.kind === 'task-notification' ? ownNotice(e.text) : undefined
    const done = from === undefined ? undefined : callDone(from)
    if (done !== undefined) return { drop: done }
    const check = from === undefined ? undefined : checkName(from)
    if (from !== undefined && check !== undefined) return { drop: await checkDone(cxOf($), from, check) }
    if (!isActive()) return next(e)
    const cx = cxOf($)
    await followConversation(cx)
    // a delivery still in flight when the person sends the next prompt never reached the conversation: owe it again
    if (act.pending) deliveryLost()
    const guide = await owedGuide(cx)
    if (!guide) return next(e)
    deliverStarts(guide)
    const r = await next({ ...e, context: [...(e.context ?? []), guide] })
    if (r.drop !== undefined) deliveryLost()
    return r
  }).catch(($, e, next) => next(e))

  // after a compaction of main's conversation: the guide appended whole as a hidden row, once the compaction is in
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!isActive() || e.agentId !== undefined || r.skip !== undefined) return r
    const cx = cxOf($)
    cx.later(0, () => void guideAfterCompact(cx).catch(err => cx.log(`thimble: the guide was not given again after the compaction: ${String(err).slice(0, 200)}`)))
    return r
  })

  // /clear and /resume end this conversation (no session.start follows): the next call of the new one rekeys thimble,
  // and after /clear its next prompt carries the guide
  on('session.end', { reason: /^/ }, async ($, e, next) => {
    conversationEnded(e.sessionId, e.reason)
    return next(e)
  })

  // a citation typed or pasted into the prompt is painted there as the reply's are, purple and underlined
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    if (!rt.sc) return r
    const d = citeSpans(r.text).map(sp => ({ start: sp.at, end: sp.end, underline: true, color: COLORS.cite }))
    return d.length ? { ...r, decorations: [...(r.decorations ?? []), ...d] } : r
  })

  // ---------------------------------------------------------------------------------------------- main's turn

  // main's turn only: a subagent's turn (a check, an orientation's helper) starting meanwhile would start main's over and
  // lose the cards made before it (README capture 10-17: a card made before four checks started was never drawn)
  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    if (rt.sc && e.agentId === undefined) {
      const own = rt.own.has(e.text)
      rt.own.delete(e.text)
      rt.turn = { id: e.turnId, at: new Date(await $.clock.now()).toISOString(), cards: [], row: '', parts: [[]], views: [], own }
    }
    return next(e)
  })

  // thimble on at the first data-file read, and what Claude's calls read of the data files (activate.ts, tracker.ts).
  // Registered with `.catch` replaying `next`: a hook that throws or outruns its budget still leaves the call's own
  // result, and the call never runs twice.
  on('tool.call', { tool: /^(?:Read|Bash|Grep|Glob|mcp__plugin_thimble_thimble__load_thimble)$/ }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool.endsWith(`__${LOAD_TOOL}`)) {
      const res = await next(e)
      if (res.deny === undefined && !res.isError) await sawLoadThimble(cxOf($), String(res.text ?? ''))
      return res
    }
    if (isActive()) {
      const res = await next(e)
      const cx = cxOf($)
      if (featureOn('coverage')) keepFacts(await factsOf(cx, await preScope(cx), { tool, input, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), result: res.result, ...(res.text !== undefined ? { text: res.text } : {}), ...(res.deny !== undefined ? { deny: res.deny } : {}), ...(res.isError ? { isError: true } : {}) }))
      if (e.agentId !== undefined || res.deny !== undefined) return res
      await followConversation(cx)
      const guide = await owedGuide(cx)
      if (!guide) return res
      deliverStarts(guide)
      return { ...res, context: [...(res.context ?? []), guide] } as typeof res
    }
    // thimble off in this session (a folder it refuses, a headless run, or the plugin turned off): a call passes as it
    // is; reading data never turns thimble on (the owner, 10-16 22:45: a regular plugin, on from the session's start)
    return next(e)
  }).catch(($, e, next) => next(e))

  // main's fork of a side thread runs with the thread's question as its description, which Claude Code's agent tray and
  // its exit dialog show beside the fork's name (never `thread:<slug>`); the prompt keeps `thread:<name>`, by which
  // thimble knows the fork (backend threads.fork_ref)
  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    let call = e
    try {
      if (rt.sc && e.agentId === undefined && e.tool === 'Agent') {
        const input = e as unknown as Record<string, unknown>
        const rows = await cxOf($).threads()
        const description = forkDescription(input, rows) ?? (input.subagent_type === 'fork' ? forkDescription(input, await threadsNow(cxOf($))) : null)
        if (description) call = { ...e, description } as typeof e
      }
    } catch {
      // the call runs as main wrote it
    }
    const ran = await next(call)
    try {
      if (!rt.sc || e.agentId !== undefined || ran.deny !== undefined) return ran
      // a card main deleted is no card of the turn's, and no answer draws or counts it (bug hunt C16: one made and
      // deleted in the same turn drew `× card 1 cannot be drawn` and counted in the footer)
      if (DELETE_TOOL.test(String(e.tool)) && !ran.isError) {
        const input = e as unknown as Record<string, unknown>
        const id = String(input.card ?? input.cell ?? '').trim().replace(/^(?:card|cell):/, '')
        if (id) cardDeleted(id)
      }
      const ids = cardsOfCall(String(e.tool), e, String(ran.text ?? ''))
      if (ids.length) {
        for (const id of ids) cardMade(id)
        if (rt.turn) for (const id of ids) if (!rt.turn.cards.includes(id)) rt.turn.cards.push(id)
        void loadCards(cxOf($), ids)
      }
      // a view main proposed: its `↳ view` row under the turn's answer
      if (VIEW_TOOL.test(String(e.tool)) && rt.turn) {
        const name = String((e as { name?: unknown }).name ?? '')
        const slug = /\bview:([a-z0-9][a-z0-9-]*)/.exec(String(ran.text ?? ''))?.[1] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (slug && !rt.turn.views.includes(slug)) rt.turn.views.push(slug)
      }
    } catch {
      // the call's answer stands whatever thimble-term makes of it
    }
    return ran
  })

  // main's reply as it streams: each citation handed to Claude Code as a Markdown link (never its raw spelling) and a
  // card's line as a placeholder naming the card; a citation, code span or card line not yet closed waits. The row is
  // stored as the model wrote it (session.append), and drawn by AssistantMessage once it is whole.
  on('turn.step', { turnId: /^/ }, async function* ($, e, next) {
    if (!rt.sc || e.agentId !== undefined) return yield* next(e)
    const cx = cxOf($)
    const blocks = new Map<number, Streaming>()
    const urls = new Map<string, string>()
    const questions = new Map<string, string>()
    const look: StreamLook = {
      link: c => streamLink(c, urls.get(c.ref) ?? ''),
      card: id => `◌ ${(questions.get(id) || 'drawing the card').replace(/[\\[\]*_`<>]/g, m => `\\${m}`)}`,
    }
    const end = (i: number, st: Streaming) => {
      const out = streamStep(st, '', true, look)
      if (st.shown !== st.raw) {
        asWritten.set(st.shown, st.raw)
        if (asWritten.size > 50) asWritten.delete(asWritten.keys().next().value!)
      }
      return out ? [{ kind: 'text' as const, index: i, text: out }] : []
    }
    for await (const ch of next(e)) {
      if (ch.kind === 'text') {
        const st = blocks.get(ch.index) ?? streaming()
        blocks.set(ch.index, st)
        const ahead = `${st.raw.slice(st.done)}${ch.text}`
        try {
          const cs = citations(ahead)
          // each citation checked as soon as it has streamed whole (the next 250 ms batch), not when its block is drawn,
          // so most checks end while the answer is still on screen
          queueCitations(cs)
          for (const c of cs) if (!urls.has(c.ref)) urls.set(c.ref, await placeUrl(cx, c.ref))
          for (const m of ahead.matchAll(/\[\[card:([A-Za-z0-9_-]+)\]\]/g)) if (!questions.has(m[1]!)) questions.set(m[1]!, ((await cx.card(m[1]!))?.data as CardData | null | undefined)?.question ?? '')
        } catch {
          // a link without its file still hides the raw spelling
        }
        const out = streamStep(st, ch.text, false, look)
        if (out === ch.text) yield ch
        else if (out) yield { ...ch, text: out }
        continue
      }
      // a block ends before anything else of the response passes: what it held back is handed over
      for (const [i, st] of blocks) yield* end(i, st)
      blocks.clear()
      yield ch
    }
    for (const [i, st] of blocks) yield* end(i, st)
  })

  // the rows of main's chat a drawing stands under, by the uuid they are stored under (their `requestId`): the
  // latest row a line can stand under, and the turn's latest text row; each text row of the turn in its part (a tool
  // call starts the next part), for the turn's answer. A block of main's reply is stored as the model wrote it, not as
  // it showed while it streamed.
  on('session.append', async ($, e, next) => {
    let msg = e.message
    try {
      if (rt.sc && e.agentId === undefined) {
        if (msg.type === 'user' && (e.door === 'prompt' || e.door === 'delivery')) heard(resultText(msg.content))
        if (e.door === 'response' && Array.isArray(msg.content)) {
          const shown = msg.content as { type?: string; text?: string }[]
          const blocks = shown.map(b => (b.type === 'text' && typeof b.text === 'string' && asWritten.has(b.text) ? { ...b, text: asWritten.get(b.text)! } : b))
          if (blocks.some((b, i) => b !== shown[i])) msg = { ...msg, content: blocks as typeof msg.content }
          const texts = blocks.flatMap(b => (b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [b.text] : []))
          if (rt.turn) {
            if (texts.length) rt.turn.parts.at(-1)!.push({ uuid: e.uuid, text: texts.join('\n\n') })
            if (blocks.some(b => b.type === 'tool_use')) rt.turn.parts.push([])
          }
          if (rt.answering && texts.length) await noteAnswer(cxOf($), e.uuid, texts.join('\n'))
          // the cards a reply embeds, read so they draw
          const embeds = texts.flatMap(t => embeddedCards(t))
          if (embeds.length) void loadCards(cxOf($), embeds)
        }
        if (isAnchor({ ...e, message: msg } as unknown as AppendedRow)) rt.anchor = e.uuid
        if (e.door === 'response' && rt.turn && hasText(msg.content)) rt.turn.row = e.uuid
      }
    } catch {
      // the row is stored whatever the terminal UI makes of it
    }
    const stored = await next(msg === e.message ? e : { ...e, message: msg })
    // the guide a delivery sent is marked sent once the row that carries it is stored in main's conversation
    if (act.pending && e.agentId === undefined && stored.deny === undefined) await rowStored(cxOf($), { text: rowText(stored.message ?? msg) })
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const done = await next(e)
    let lineRow = ''
    if (rt.sc && e.agentId === undefined && rt.turn) {
      const t = rt.turn
      rt.turn = null
      const row = t.row || rt.anchor
      const cx = cxOf($)
      lineRow = row
      if (t.cards.length && row) {
        const cur = await cx.turnCards(row)
        await cx.setTurnCards(row, [...cur, ...t.cards.filter(id => !cur.includes(id))])
      }
      // what `/thimble cite` and `/thimble card` open: the turn's citations and cards
      const all = t.parts.flat().map(r => r.text).join('\n\n')
      if (all.trim()) rt.lastReply = all
      if (all.trim() || t.cards.length) rt.lastCards = [...new Set([...embeddedCards(all), ...t.cards])]
      if ((all.trim() || t.cards.length) && rt.sc) await keepLast(cx, rt.sc.ws, rt.lastReply, rt.lastCards)
      // the answer: its last part that cites or embeds a card, else its last; the footer stands under its last row
      const part = answerPart(t.parts)
      const last = part?.at(-1)?.uuid ?? ''
      if (part && last && !t.own) {
        const text = part.map(r => r.text).join('\n\n')
        const shows = [...new Set([...embeddedCards(text), ...(last === row ? t.cards : [])])]
        if (citations(text).length || shows.length) await cx.setAnswer(last, { rows: part.map(r => r.uuid), text, cards: shows })
      }
      // the views this turn proposed: their rows under the answer
      const vrow = last || row
      if (t.views.length && vrow) {
        const cur = await cx.viewRows(vrow)
        await cx.setViewRows(vrow, [...cur, ...t.views.filter(v => !cur.includes(v))])
        for (const v of t.views) rt.viewsTold.add(v)
      }
      lineRow = vrow
      // the chat citations the answer drew, for the panel's Citations view (C13 citeIndex)
      if (featureOn('citationMarks') && all.trim() && !t.own) await indexCitations(cx, all, last || row)
    }
    // what the turn's calls saw of the data, sent once: the session's summary, which the thimble line's coverage and the
    // Coverage view read (no line under the answer: coverage lives in the thimble line, the owner's live test, 10-17)
    if (isActive() && e.agentId === undefined && featureOn('coverage') && factsHeld()) {
      const cx = cxOf($)
      const summary = await flushFacts(cx, await cx.sessionId(), lineRow || rt.anchor)
      if (summary) await cx.setCoverageSummary(summary)
    }
    return done
  })

  // ---------------------------------------------------------------------------------------------- main's chat

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const ids = liveCards(await cx.turnCards(e.requestId))
    const told = await signalRows(cx, e)
    const views = await viewRowsEl(cx, e)
    const footer = await footerEl(cx, e)
    // without main's end token, and a `↳ thread` line naming its thread by its first question, not its fork's slug; no
    // such line for a thread whose `↳ thread` row the terminal UI drew, which says the same
    const rows = await cx.threads()
    // Claude Code's own stand-in for a reply that never came (its `<synthetic>` text, as after a quit stopped a thread),
    // which main never wrote: not drawn (live check term-fix9, quirk 13)
    const said = SYNTHETIC_RE.test(e.props.text) ? '' : e.props.text
    // and none of main's `↳` lines that answer a subagent run's second report, whose first an earlier row answered
    const repeats = rt.repeats.get(e.requestId)
    const text = await withoutSaidWriter(cx, e.requestId, namedThreads(withoutToldThreads(withoutEnd(repeats ? withoutLines(said, repeats) : said), rows, rt.told), rows))
    // the document a writer finished, linked out to the browser workbench under the row that says so
    const written = await writtenEl(cx, e, text)
    const live = e.surface === 'terminal' || e.surface === 'desktop'
    if (!ids.length && !told && !views && !footer && !written && text === e.props.text && !live && !needsDrawing(text)) return next(e)
    const { Box } = $.ui.resolve(e)
    // the reply fills the terminal's width, less 2, its cards as wide as its prose
    const cols = (e.viewport?.columns ?? 100) - 2
    // the checks' comments on this row's passages: each passage tinted in its check's color, a flag in the margin
    const checked = await commentsFor(cx, e, text, cols - MARGIN, ids.length)
    // a sentence that cites a card whole keeps its chip (`[ card ]`) though the card is drawn under the reply
    const body = text.trim() ? await drawReply(cx, e, text, cols - MARGIN, { first: Boolean(e.props.isFirstOfReply), skipCards: new Set(ids), ask: t => openAsk(cx, t), open: id => openThread(cx, id), ...(checked.length ? { comments: checked, lit: await cx.checksOpen(), check: id => openChecks(cx, id) } : {}) }) : []
    const cards = await drawCards(cx, e, ids, cols, t => openAsk(cx, t), id => openThread(cx, id))
    // a block that held only a line the terminal UI hides: nothing (ctrl+o's view still draws the reply's time and model
    // above it, which no hook reaches; the engine's own block with no text draws the same)
    if (!body.length && !cards && !told && !views && !footer && !written) return <Box />
    // one blank row above, as above Claude Code's own reply rows: the engine's row carries that margin itself, and this
    // tree takes the row's place, so without it the reply sits right under the person's message
    return (
      <Box flexDirection="column" marginTop={1}>
        {body}
        {written}
        {cards}
        {footer}
        {told}
        {views}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  // /thimble's line as thimble says it, not under the plugin's name, which Claude Code puts before a hook's answer
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    // `/thimble …` answers as thimble, not under the plugin's name, which Claude Code puts before a hook's answer
    const own = (e.props.command === 'thimble:thimble' || e.props.command === 'thimble') && /^\s*thimble:\s*thimble\b/.test(e.props.text)
    const shown = own ? { ...e, props: { ...e.props, text: e.props.text.replace(/^\s*thimble:\s*(?=thimble\b)/, '') } } : e
    return underRow(cxOf($), e, () => next(shown))
  })

  // a thimble tool's row, and a card's run in Bash, name the card by its question, never by its id, and a citation by
  // its words (in the row and in ctrl+o's detailed view); a side thread's fork is named by the thread's first question,
  // never its slug
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const tool = String(e.props.tool)
    const input = e.props.input as Record<string, unknown> | undefined
    if (!input || typeof input !== 'object') return next(e)
    if (THIMBLE_TOOL.test(tool)) {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input)) {
        const s = typeof v === 'string' ? await toolWords(cx, k, v) : v
        if (s !== v) changed = true
        out[k] = s
      }
      return changed ? next({ ...e, props: { ...e.props, input: out } }) : next(e)
    }
    if (tool === 'Bash' && typeof input.command === 'string' && /thimble-run\b/.test(input.command)) {
      return next({ ...e, props: { ...e.props, input: { ...input, command: await runWords(cx, input.command) } } })
    }
    if (tool === 'Agent' || tool === 'Task') {
      // a fork's description and its prompt (ctrl+o's `Prompt:`) name the thread by its first question, never its slug
      const threads = await cx.threads()
      const named = (v: unknown) => (typeof v === 'string' && /\bthread:/.test(v) ? namedForks(v, threads) : v)
      const description = named(input.description)
      const prompt = named(input.prompt)
      const output = forkOutput(e.props.output, threads)
      if (description !== input.description || prompt !== input.prompt || output !== e.props.output) return next({ ...e, props: { ...e.props, input: { ...input, description, prompt }, ...(output !== undefined ? { output } : {}) } })
    }
    return next(e)
  })

  // the row saying a side thread's fork finished names the thread by its first question, never the fork's slug. A
  // thimble event's wake-up (.thimble-watch's asyncRewake, summary `thimble`, no task) is no row: a bare `● thimble`
  // says nothing, and what came in shows in the lines the held hook prints with the turn (`› ` the analyst's words,
  // `new thread: …`; bug hunt B5); ctrl+o's full view still draws it
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    if (rt.sc && e.props.text.trim() === REWAKE_SUMMARY && !e.props.task && !e.props.isExpanded) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    if (!rt.sc || !/\bthread:/.test(e.props.text)) return next(e)
    const text = namedForks(e.props.text, await cxOf($).threads())
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // a card tool's result row: the card by its question, since the card itself is drawn under the turn's last reply; a
  // label's, its name and each value's count. An error stays Claude Code's row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!rt.sc || e.props.isErrored) return next(e)
    // a fork's result (`Backgrounded agent`, and in ctrl+o its `Prompt:`) names the thread by its first question
    if (e.props.tool === 'Agent' || e.props.tool === 'Task') {
      const output = forkOutput(e.props.output, await cxOf($).threads())
      return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } })
    }
    if (!CARD_TOOL.test(String(e.props.tool))) return next(e)
    const ids = cardsOfCall(String(e.props.tool), {}, resultText(e.props.output))
    const tc = ids[0] ? await cxOf($).card(ids[0]) : undefined
    const data = tc?.data as CardData | null | undefined
    const q = data?.question
    if (!q) return next(e)
    const { Text } = $.ui.resolve(e)
    // the row cut at a word, as every cut, to the terminal's width
    const room = Math.max(20, (e.viewport?.columns ?? 100) - 2)
    if (data.kind === 'label' && data.label) {
      const counts = ((data.rows ?? []) as { label: string; value: number }[]).map(r => `${r.label} ${r.value.toLocaleString('en-US')}`).join(' · ')
      return <Text dimColor wrap="truncate-end">{cut(`  ⎿  label ${quoted(data.label.name)}${counts ? ` · ${counts}` : ''}${tc?.busy ? ` · ${tc.busy}` : ''}`, room)}</Text>
    }
    return <Text dimColor wrap="truncate-end">{cut(`  ⎿  card ${quoted(q)}${tc?.busy ? ` · ${tc.busy}` : ''}`, room)}</Text>
  })

  // ---------------------------------------------------------------------------------------------- above the prompt

  // the rows above the prompt (band.tsx), and the panel's views drawn by modules of their own (views.ts)
  registerBand(on)
  registerPanelViews(on)

  // ---------------------------------------------------------------------------------------------- the panel

  // the panel's drawings run one at a time (turns.ts, two seconds at most each); one that settles after a later one
  // began, or that Claude Code abandoned, draws once more 50 ms after, so the shown panel's buttons and fields work
  const paneDraws = { draws: 0, settled: 0, redrawing: false }
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const pe = e as PaneEvent
    const cx = cxOf($)
    noteScreen(pe.surface, (pe.viewport as { isFullscreen?: unknown } | undefined)?.isFullscreen)
    // a pane that waited undrawn is drawn now (Claude Code placed it once the terminal was wide enough): the row above
    // the prompt that offered it goes
    if (rt.waiting) {
      rt.waiting = false
      $.clock.after(0, () => void placedLater(cx))
    }
    if (pe.surface === 'terminal' && pe.viewport?.columns && (pe.props.placement === 'dock' || pe.props.placement === 'inline')) {
      rt.termColumns = pe.props.placement === 'dock' ? pe.viewport.columns + pe.props.bodyColumns + 1 : pe.viewport.columns
      // a resize keeps the dock at the width it was opened with: it opens again at the panel's width for the terminal
      // now (a width the person dragged still wins)
      if (pe.props.placement === 'dock' && rt.termColumns !== rt.fittedFor && rt.termColumns >= 110) {
        rt.fittedFor = rt.termColumns
        if (panelColumns() !== pe.props.bodyColumns) {
          $.clock.after(0, () => {
            void (async () => {
              const placed = (await cx.panes()).some(p => p.id === PANEL && p.isPlaced)
              const p = await cx.panel()
              if (placed && p) await cx.open({ id: PANEL, title: paneTitle(p), columns: panelColumns() }).catch(() => undefined)
            })()
          })
        }
      }
    }
    return paneTurns.run(async () => {
      const n = ++paneDraws.draws
      await read($, panelTickA)
      const tree = await drawPanel(cx, pe)
      const late = paneDraws.settled > n
      paneDraws.settled = Math.max(paneDraws.settled, n)
      if ((late || next.signal.aborted) && !paneDraws.redrawing) {
        paneDraws.redrawing = true
        $.clock.after(50, () => {
          paneDraws.redrawing = false
          // an aborted drawing draws again only when no drawing began since; drawing again regardless would abort a
          // drawing slower than 50 ms each time, and the panel would never show
          if (late || paneDraws.draws === n) void update($, panelTickA, k => (k ?? 0) + 1)
        })
      }
      return tree
    }, fire => $.clock.after(2000, fire))
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANEL) {
      rt.panelFocus = ''
      // typing that went to the prompt ends with the pane: opened again, the panel has its keys
      keysBack()
      rt.waiting = false
      await $.state.set(pendingRef, null).catch(() => undefined)
      await $.state.set(panelA, null).catch(() => undefined)
      // a terminal view's program ends with its pane
      closeView()
    }
    return closed
  })

  // the panel's focus ring: while a text field holds it the hint row names Enter and Esc alone (panel.tsx endHints),
  // since a letter goes into the field; off every element, NO_FOCUS (not '', which is a view just opened)
  const NO_FOCUS = '-'
  // A list's keys reach it through the relay's three Buttons (panel.tsx RELAY): a move of the ring from the middle one
  // onto a neighbour (↑, ↓, Tab) is that key for the list, and the ring stays unless the key moved it off the list
  // (relayMoveKey); a move onto a neighbour from elsewhere lands on the middle one. Every move draws the panel again, so its hint row names the keys where the ring is.
  on('ui.focus', { requestId: PANEL }, async ($, e, next) => {
    // the person moving the ring while the panel's typing went to the prompt (panel.tsx typeThrough), or the relay's
    // field taking it as the pane takes the keys from the prompt (a click on the pane): the panel has its keys again
    if (rt.sc && rt.typeThrough && (e.origin.kind === 'person' || rt.typeAway)) keysBack()
    const how = rt.sc ? relayMove(rt.panelFocus, e.element) : ''
    if (how === 'up' || how === 'down') {
      const to = await relayMoveKey(how).catch(() => '')
      // the key moved the ring off the list (↓ past the labels list's last label): the person's move lands there
      if (to) {
        const moved = await next({ ...e, element: to })
        if (!moved.deny) rt.panelFocus = to
        void cxOf($).bumpPanel()
        return moved
      }
      void cxOf($).bumpPanel()
      // a document's comment the key chose, scrolled into view once the panel is drawn again
      scrollPending(cxOf($))
      return {}
    }
    // a ring put back on a text field the panel no longer draws (the new thread's form left by back, live check
    // term-fix9, quirk 1) is on none of its elements: onto the list's keys when it draws a list
    const stale = Boolean(rt.sc && e.element && focusedField(e.element) && !rt.fields.has(e.element))
    const park = how === 'park' || (stale && hasList())
    const moved = await next(park ? { ...e, element: RELAY.pick } : e)
    try {
      if (rt.sc && !moved.deny) {
        rt.panelFocus = park ? RELAY.pick : stale ? NO_FOCUS : (e.element ?? NO_FOCUS)
        void cxOf($).bumpPanel()
      }
    } catch {
      // the ring moves whatever thimble-term makes of it
    }
    return moved
  })

  // the wheel over a list the panel cut to its rows (panel.tsx windowList) moves the list's rows, the choice where it is;
  // over any other panel the pane scrolls
  on('ui.scroll', { requestId: PANEL }, async ($, e, next) => {
    if (!rt.sc || !e.pointer || e.origin.kind !== 'person') return next(e)
    // over a terminal view the wheel is the view's: the list under the pointer moves its rows, so it goes with the
    // frame's cell there
    if (openViewState()?.id && (await cxOf($).panel())?.view === 'view') {
      void sendEvent(cxOf($), { t: 'wheel', by: e.by, ...viewWheelAt(e.pointer) })
      return {}
    }
    if (!wheelWindow(e.by)) return next(e)
    void cxOf($).bumpPanel()
    return {}
  })

  // ---------------------------------------------------------------------------------------------- clicks

  // "ask" beside a selection (para.tsx): its press is the person's own (a press on a card's title is a gesture,
  // card.tsx, which asks a side thread about the card)
  on('ui.press', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const inPanel = e.component === 'Pane' && e.requestId === PANEL
    // a press on the panel once the prompt had the keys is a click, as no hotkey presses there: the panel has its keys
    // again, and the Button acts rather than typing its letter into the prompt (panel.tsx typedOr)
    if (inPanel && rt.typeThrough && rt.typeAway) keysBack()
    await navOrigin(cx, inPanel)
    // a press on one of the panel's own acts keeps the panel's keys (bug hunt B28; term.ts keepKeys)
    if (inPanel) keepKeys(cx)
    if (e.element === 'sel-ask' && rt.selection) await openAsk(cx, { kind: 'sentence', text: rt.selection.slice(0, 1200) })
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const d = (e.data ?? {}) as Record<string, unknown>
    const inPanel = e.component === 'Pane' && e.requestId === PANEL
    // every post of a Client that uses hooks/gestures.tsx carries its recent gestures; each is handled once
    if (Array.isArray(d.gestures) && typeof d.origin === 'string') {
      const last = rt.seenGestures.get(d.origin) ?? 0
      const fresh = (d.gestures as Sent[]).filter(g => typeof g?.seq === 'number' && g.seq > last)
      if (fresh.length) rt.seenGestures.set(d.origin, Math.max(...fresh.map(g => g.seq)))
      // a click in the panel (a card's mark, a passage's link) keeps the panel's keys, as a press there does
      if (inPanel && fresh.some(g => g.gesture && g.target)) keepKeys(cx)
      for (const g of fresh) {
        if (!g.gesture || !g.target) continue
        // a click on a passage a check commented on: the panel at Checks on that comment (the ref is its id)
        if (g.target.kind === 'check') {
          await openChecks(cx, g.target.ref ?? '')
          continue
        }
        await navOrigin(cx, inPanel)
        try {
          await onGesture(cx, g.gesture, g.target)
        } catch (err) {
          $.ui.log(`thimble-term: the ${g.gesture} gesture failed: ${String(err).slice(0, 200)}`)
        }
      }
    }
    if (d.type === 'home') {
      await navOrigin(cx, inPanel)
      // a click on a part drawn from lines (a link, `↳`, a row) keeps the panel's keys
      if (inPanel) keepKeys(cx)
      await linesMessage(cx, d.horigin, d.hacts)
    } else if (d.type === 'view') {
      // a click or a drag in a terminal view (viewclient.tsx); like a click on a list, it gives the pane its keys back
      await navOrigin(cx, inPanel)
      if (await viewMessage(cx, d)) await takeKeys(cx)
    } else if (d.type === 'copy' && typeof d.text === 'string') {
      const text = d.text.slice(0, 100000)
      rt.selection = text
      const r = await $.ui.copy({ text, surface: e.surface })
      $.ui.toast(r.isCopied ? `copied ${text.length} characters` : `could not copy: ${r.reason}`)
    } else if (d.type === 'label-open' && typeof d.slug === 'string') {
      // a press on a card's label row (its name or its ↗): the label's panel, under its name
      await navOrigin(cx, inPanel)
      if (inPanel) keepKeys(cx)
      const find = async () => {
        const got = await surfaceValue(cx, 'labels')
        return got?.ok ? labelsOf(got.value).find(l => l.id === d.slug || l.name === d.slug) : undefined
      }
      // the labels as last read may be older than the label (home read them before main made it): read them again
      let hit = await find()
      if (!hit) {
        await readSurface(cx, 'labels', 'labels')
        hit = await find()
      }
      if (!hit) cx.toast('that label is no longer in this workspace')
      else await openLabel(cx, hit.id, hit.name ?? hit.id)
    } else if (d.type === 'field' && typeof d.name === 'string' && typeof d.text === 'string') {
      // a field's words (field.tsx): a draft, or a save
      await fieldMessage(cx, d.name, d.text.slice(0, 20000), d.save === true)
    } else if (d.type === 'files-open' && typeof d.path === 'string') {
      await openFile(cx, d.path)
    }
    return next(e)
  })

  // a Client of thimble-term that could not draw (its tree did not validate, its module threw): why goes to the debug
  // log, never to main's chat; the open view's own says so in the panel, dim, in its place (panel.tsx drawView), as
  // the engine draws the panel again once this answers
  on('ui.fault', async ($, e, next) => {
    $.ui.log(`thimble-term: ${e.module} could not draw in ${e.component} (${e.phase}): ${e.reason}`, { to: 'debug' })
    if (e.component === 'Pane' && e.requestId === PANEL && /(^|\/)viewclient\.tsx$/.test(e.module)) viewFault(e.reason)
    return next(e)
  })
}
