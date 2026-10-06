// thimble-cc-mod: a single-agent thimble inside Claude Code. No server, no browser.
//
// - Prompting: prompt/chat.md rides with the first prompt of a conversation as context (managed settings on this
//   machine bypass a user plugin's prompt.compose). It tells main to answer card shaped or report shaped, numbers from
//   code, every number cited.
// - Cards: main's Python writes a card with helper/tcard.py (.thimble-cc-mod/cards/<id>.json); a reply line holding only
//   [[card:<id>]] is drawn as the card's panel there, between the reply's text, by the Client card.tsx. A card is one
//   of six typed specs; one that does not validate is drawn as an error, and a fix round corrects it. The helper
//   writes cards to the session's folder (THIMBLE_CC_MOD_ROOT, set at session.start), wherever the script runs.
// - Citations: every [[...]] of a reply is drawn as a link (para.tsx, cite.ts), red when helper/resolve.py finds the
//   ref missing or without its value. The citation panel shows the cited lines, highlighted.
// - Fix rounds: when a reply has red citations or a card that cannot be drawn, a forked subagent corrects them, out of
//   main's chat; each corrected sentence replaces the old one in place, unmarked, and main is told in a note it reads
//   but the analyst does not see. A red citation shows a spinner while the fork works, and ✗ when the fix failed.
// - Verification scripts: a forked subagent writes a standalone script that recomputes a cited value; the mod runs it
//   and marks the citation ✓, or ✗ and red. A spinner shows meanwhile. The panel shows the script and its output.
// - Gestures (gestures.tsx): every target (card, mark, sentence, citation, row, record, node) takes the same clicks;
//   a right-click does what a click does. There is no menu.
// - Side threads (threads.tsx): a forked subagent answers out of main's chat, in the panel.
// - Every subagent of the mod (side threads, fix rounds, verifications, report writers, highlighters, view builders and
//   reviewers) is a fork of main, so it has main's whole conversation; a general-purpose subagent given the guidance
//   is the fallback where a fork is refused. A fork ends without any notice to main: the mod reads its answer at its
//   turn.complete and leaves main one note main reads with its next prompt and the analyst does not see ("side thread
//   answered: …", "view ready: …"). A fallback's hand-back is its answer; the prompt it would start in main is dropped
//   (one line).
// - A side thread's answer with red citations gets a fix round of its own, its corrections put in the thread.
// - Each answer's footer and each citation's fix and verification are kept in .thimble-cc-mod/marks.json, so a resumed
//   session draws them again.
// - Bash results: each output is saved (.thimble-cc-mod/calls/<id>.json) and main is told its ref, so it can cite a line.
// - Reports (reports.tsx): a writer subagent writes a document, slides or a story of the work, started by main's
//   `report` tool, /thimble-report, or "open as report" under an answer; the panel draws each form.
// - The panels' chrome (chrome.tsx): the path row, an accent title and a dim subtitle, a rule, the panel's parts, its
//   actions at the bottom after a rule, and a dim italic row of key hints (views/SPEC.md, "The visual system").
// - While a reply streams, the engine is handed its text with each citation as a Markdown link and each card's embed
//   line as a placeholder (turn.step), so no raw [[...]] shows; the row is stored as the model wrote it (session.append).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, MatchedEvent, Register, RenderElement, ResolveInput, SessionAppendMessage } from 'claude-code'

import type { ChatAgent, ChatCorrection, ChatEnd, ChatFixItem, ChatRow, ChatRun, ChatThread, ChatVerdict, ChatVerify } from '../types'
import { focusFromRef } from './anim'
import type { Focus } from './anim'
import { answerFile, applyCorrections, richMarkdown, blockClaims, blockLayout, capLine, chipLook, chipSegs, chipState, citeLabel, citedAs, citedPlace, claimsIn, correctText, emptyMarks, fixItems, fixPrompt, fixedCard, marksJson, paraLayout, parseFix, parseMarks, plainCites, quoteSpan, quotedWords, scriptAim, setMark, settleFix, showsValue, streamLink, streamStep, streaming, verifyFailed, verifyMatches, wrapAround } from './cite'
import type { ChipView, Claim, Marks, Problem, StreamLook, Streaming } from './cite'
import { MAX_BARS, MAX_EDGES, MAX_NODES, MAX_TABLE_ROWS, cardLayout, cut, labelHead, lineWidth, placeWords, shade, width as textWidth } from './draw'
import { ACCENT, FRESH, LINK, MARGIN_W, TIP, controlsEl, fieldEls, freshSeg, hasMargin, headerEls, hintLine, hintsEl, lineEl, linkSeg, marginKey, pointed, ruleEl, ruleLine, spread, subLine, titleLine } from './chrome'
import type { BarRow, CardData, CardMeta, Cell, Item, Layout, Line } from './draw'
import { askPieces, chipLabel, cid, citations, citeSpans, clip, embeddedCards, fmt, fromMod, mdPieces, sectionsOf, inlineRuns, needsDrawing, parseReply, scriptResult, takeawayAfter, threadBody, validateCard } from './lib'
import type { Citation } from './lib'
import { COLORS, paintLine, paintLines } from './paint'
import { cardOf, citationOf, citeText, placeOf, targetLabel } from './gestures'
import type { Act, Gesture, PointerEv, Sent, Target } from './gestures'
import { passageKey, reportCards, typeOf } from './report'
import { HIGHLIGHT_DESCRIPTION, HIGHLIGHT_SCHEMA, HIGHLIGHT_TOOL, REPORT_COMMAND_DESCRIPTION, REPORT_TOOL, TOOL_DESCRIPTION, TOOL_SCHEMA, allReports, drawReport, drawReports, highlightTool, highlightToolLine, openAsReport, reportAgentDone, reportAppend, reportCommand, reportNav, reportTool, reportToolLine, reportsCommand, showReport } from './reports'
import type { ReplyOpts, ReportCtx } from './reports'
import { MOD_AGENT, aboutLine, fallbackName, fixName, forkPrompt, freshPrompt, lastTurn, parseThread, pinCalls, threadFile, threadJson, threadName, threadNote, verifyName, withGuide, withNotes, withoutTaskLine } from './threads'
import type { ThreadCall } from './threads'
import { turns } from './turns'
// views (views/SPEC.md)
import { VIEW_MARGIN, hitRecord, hitSel, inTurn, initialState, packHits, reduce, rowContext, viewLayout } from './viewdraw'
import type { Effect, Hit, HitAct, ViewAct, ViewMeta, ViewState } from './viewdraw'
import { SLUG_RE, validateData, validateSpec } from './viewspec'
import type { ViewData, ViewSpec } from './viewspec'
import type { ChatViewState } from '../types'
// the view pipeline (views/SPEC.md, "The pipeline")
import { ACTIVE, afterBuild, afterReview, buildName, buildPrompt, buildStart, examplesText, fill, findingsText, handbackFrom, handbackReport, lastLook, parseFindings, parseProposal, proposalBullets, reviewName, stateWords, stepOf, touchesProposals, viewReadyNote, viewsCount } from './viewpipe'
import type { BuildStatus, Proposal } from './viewpipe'
import type { ChatViewPipeRow } from '../types'
// the file browser (/thimble-files)
import { FILES_TREE, fileRef, recordState } from './files'
// the panel's way: its breadcrumb, back and the threads tree (hooks/nav.ts)
import { NAV_EMPTY, activity, afterGlyph, answered, backTarget, crumbSteps, fitCrumbs, moved, nextTrail, threadBehind, threadOnTrail, threadState, threadTitle, threadTree, unread, withBack } from './nav'
import type { ChatNav, ChatNavStep, ChatNews, ChatSignal } from '../types'
// a side thread's answer the analyst did not see come: its row in main's chat, its unread marks (hooks/signal.ts)
import { SIGNALS_EMPTY, isAnchor, newsOf, parseSignals, signalEnd, signalQuestion, signalRead, signalsJson, withSignal } from './signal'
import type { SignalFile } from './signal'
// the harness: coverage, labels, the orientation (hooks/harness.tsx)
import { LABEL_DESCRIPTION, LABEL_SCHEMA, LABEL_TOOL, ORIENT_DESCRIPTION, ORIENT_SCHEMA, ORIENT_TOOL, checkNote, coverageAfterTurn, coverageAppend, coverageCommand, coverageContext, coverageDetail, coverageLast, drawCoverage, drawLabel, drawLabels, isOrient, labelCommand, labelTool, labelToolLine, labelVerdict, labelsCommand, openLabel, orientCommand, orientEnded, orientTool, orientToolLine } from './harness'
import type { HarnessCtx } from './harness'
import { SCRIPTS, boxedArgv, noPlan, parsePlan, unboxedNotice } from './sandbox'
import type { SandboxPlan } from './sandbox'
// the home panel (home.ts, drawn by homeview.tsx)
import { HOME_UI_EMPTY, groupCards, homeLayout, homePick, homeReduce } from './home'
import type { HomeAct, HomeCard, HomeCardGroup, HomeData, HomeLayout, HomeOpen, HomeUi } from './home'

type Dollar = EngineInterface

const VERDICTS = { plugin: 'thimble-cc-mod', key: 'verdicts' } as const
const VERIFY = { plugin: 'thimble-cc-mod', key: 'verify' } as const
const RUNS = { plugin: 'thimble-cc-mod', key: 'runs' } as const
const THREADS = { plugin: 'thimble-cc-mod', key: 'threads' } as const
const ENDS = { plugin: 'thimble-cc-mod', key: 'ends' } as const
const FIXES = { plugin: 'thimble-cc-mod', key: 'fixes' } as const
const AGENTS = { plugin: 'thimble-cc-mod', key: 'agents' } as const
const CORRECTIONS = { plugin: 'thimble-cc-mod', key: 'corrections' } as const
const openA = atom({ plugin: 'thimble-cc-mod', key: 'open' } as const, '')
const turnA = atom({ plugin: 'thimble-cc-mod', key: 'turn' } as const, null)
const hiddenA = atom({ plugin: 'thimble-cc-mod', key: 'hidden' } as const, '')
const correctionsA = atom(CORRECTIONS, [])
const paneCardA = atom({ plugin: 'thimble-cc-mod', key: 'paneCard' } as const, '')
const paneModeA = atom({ plugin: 'thimble-cc-mod', key: 'paneMode' } as const, '')
const pickedA = atom({ plugin: 'thimble-cc-mod', key: 'picked' } as const, '')
const hoverA = atom({ plugin: 'thimble-cc-mod', key: 'hover' } as const, '')
const bandA = atom({ plugin: 'thimble-cc-mod', key: 'band' } as const, false)
const threadA = atom({ plugin: 'thimble-cc-mod', key: 'thread' } as const, '')
const threadListA = atom({ plugin: 'thimble-cc-mod', key: 'threadList' } as const, [])
const pendingA = atom({ plugin: 'thimble-cc-mod', key: 'pending' } as const, null)
const viewA = atom({ plugin: 'thimble-cc-mod', key: 'panelView' } as const, '')
const panelRedrawA = atom({ plugin: 'thimble-cc-mod', key: 'panelRedraw' } as const, 0)
const REPORTS = { plugin: 'thimble-cc-mod', key: 'reports' } as const
const reportNavA = atom({ plugin: 'thimble-cc-mod', key: 'reportNav' } as const, null)
const NAV = { plugin: 'thimble-cc-mod', key: 'nav' } as const
const navA = atom(NAV, NAV_EMPTY)
const THREAD_SEEN = { plugin: 'thimble-cc-mod', key: 'threadSeen' } as const
const THREAD_ROWS = { plugin: 'thimble-cc-mod', key: 'threadRows' } as const
const VIEW_ROWS = { plugin: 'thimble-cc-mod', key: 'viewRows' } as const
const NEWS: ChatNews = { n: 0, one: '' }
const newsA = atom({ plugin: 'thimble-cc-mod', key: 'threadNews' } as const, NEWS)

// One panel shows a citation, a card, the threads (one of them selected), a view, a report or the home panel, by
// `panelView`. A click on what a Client draws
// is no person's asking to the engine, so a panel it opens waits undrawn below 144 columns. The engine lowers that to
// 110 for a pane the person opened before, so the mod holds such a click's panel itself below 144 (openPane); once the
// panel is open, a click only changes what it shows. The panel closes by its own button, not by Esc.
const PANEL = 'thimble'
const CLICK_FLOOR = 144
// The panel asks for 96 columns, less where main would keep under 70 beside it (the engine's own share leaves 70).
const PANEL_COLS = 96
const MAIN_KEEP = 70
type PanelView = 'cite' | 'card' | 'thread' | 'threads' | 'view' | 'views' | 'report' | 'reports' | 'coverage' | 'label' | 'labels' | 'home'
const HOME = '.thimble-cc-mod'
const CARD_MAX_COLS = 120
const GUIDE_MARK = '# thimble-cc-mod\n'
const STATUS_WORDS: Record<string, string> = {
  ok: 'the value is at the place',
  differs: 'the place resolves, but the value is not there',
  missing: 'the place does not resolve',
  unchecked: 'the place resolves; the value is not checked',
  pending: 'not checked yet',
}

/** Where a citation's place is, in words: on the card, in the command's output at a line, in a file at a line. */
function foundWhere(c: Pick<Citation, 'ref'>, v: ChatVerdict | undefined): string {
  if (v?.kind === 'value' || v?.kind === 'card' || c.ref.startsWith('card:')) return 'on the card'
  if (v?.kind === 'call' || c.ref.startsWith('call:')) {
    const line = v?.start ?? Number(/#L(\d+)/.exec(c.ref)?.[1] ?? 0)
    return `in the command's output${line ? `, line ${line}` : ''}`
  }
  return `in ${placeWords(c.ref)}`
}

/** A verification's result in words: a place a script found (`L100-L120`, `row=12`) as `lines 100-120` or `row 12`, a
 *  value as written. */
function resultWords(result: string | null | undefined): string {
  const r = String(result ?? '')
  return /^(L\d+(-L?\d+)?|row=\d+)$/.test(r) ? placeWords(`#${r}`).trim() : r
}

/** Whether a verification checked a place (link words that show no value) rather than a value. */
function placeRun(run: ChatVerify): boolean {
  return run.expected !== null && run.expected !== undefined && !showsValue(run.expected) && Boolean(citedPlace(run.ref ?? ''))
}

/** A citation by its words, or, for a place cited without words, the place in words (`revisions.jsonl line 10879`):
 *  the citation panel's title and its step in the path. */
function citeTitle(c: Citation): string {
  return c.display ?? (fileRef(c.ref) ? placeWords(c.ref) : citeLabel(c))
}

/** What a citation's status says, in plain words (views/SPEC.md, "Words that recur"): `found on the card`, `found in
 *  revisions.jsonl line 10566`, `found in the command's output, line 1` or `not found in …`; after a verification,
 *  `…, and a script got the same number` or `…, but a script got 5,883`. It agrees with the link's colour and mark. */
function statusWords(c: Citation, v: ChatVerdict | undefined, status: string, run: ChatVerify | undefined): string {
  const where = foundWhere(c, v)
  const place =
    status === 'pending' || !v
      ? '◌ checking'
      : status === 'missing'
        ? `not found: ${placeName(c.ref)} does not exist`
        : status === 'differs'
          ? `not found ${where}`
          : status === 'unchecked' && showsValue(c.display)
            ? `${where}; its value is not checked`
            : `found ${where}`
  if (!run) return place
  if (run.kind === 'support' && (run.state === 'verified' || run.state === 'refuted')) return `${place}; a subagent read it, and it ${run.state === 'verified' ? 'supports' : 'does not support'} the sentence`
  if (run.state === 'verified') return `${place}, and a script ${placeRun(run) ? 'found the same lines' : 'got the same number'}`
  if (run.state === 'refuted') return `${place}, but a script ${placeRun(run) ? 'found' : 'got'} ${resultWords(run.result)}`
  if (run.state === 'asked') return `${place}; ◌ a script is being written`
  if (run.state === 'running') return `${place}; ◌ the script runs`
  return `${place}, but the script failed`
}

// ------------------------------------------------------------------------------------------------ module state

let guide = ''
let debug = false
let root = ''
let cwd = ''
const known = new Map<string, Citation>() // every citation seen, by id
const viewRecords = new Map<string, string>() // the records a view opened in the panel, by citation id: the row's title
const claimMap = new Map<string, Claim>() // every claim drawn or checked, by its key
const quotes = new Map<string, string>() // a record's citation id -> the quoted passage of the example opened
let lastReply = '' // main's last reply, for /thimble-ask
const cardReply = new Map<string, string>() // a card's id -> the reply text that embeds it
const cards = new Map<string, { mtime: number; data: CardData | null; error: string; why: string }>()
const mouseLog: string[] = []
let threadSeq = 0
let selection = '' // the text last selected in a paragraph, which its "ask about this" asks about
const seen = new Map<string, number>() // a gestures module instance -> the last gesture it sent that was handled
let lastCards: string[] = [] // the cards of main's last reply that embeds any, in order
const handbacks = new Map<string, string>() // a fallback subagent's report through SubagentHandback, by its agent id
let mainBusy = false // main's turn runs
const afterMain: (() => Promise<void>)[] = [] // what waits for it to end (a view's builder or reviewer, a report's writer)
let guideSent = false // the guidance went with a prompt of this conversation
// when this session (or this load of the hooks) began: proposals made since get their `↳ view` row
let sessionAt = Date.now()
// Notes main reads and the analyst does not see (noteMain) wait for main's next prompt and go with it. One appended to
// the transcript between turns would be its last row, which a resumed session takes for a prompt left unanswered, and
// Claude Code answers it in main's chat ("No response requested."). NOTES keeps them for a session resumed before then.
let notes: string[] = []
const NOTES = `${HOME}/notes.json`
// each answer's footer rows and each citation's fix and verification (cite.ts Marks), kept in MARKS for a resume
let marks: Marks = emptyMarks()
const MARKS = `${HOME}/marks.json`
let marksSaved: Promise<void> = Promise.resolve()
// the rows in main's chat saying a side thread answered, by the row each stands under, the latest row one can stand
// under, and the answers of each thread the analyst has seen (hooks/signal.ts), kept in SIGNALS for a resume
let signals: SignalFile = { ...SIGNALS_EMPTY, seen: {}, rows: {}, views: {} }
const SIGNALS = `${HOME}/signals.json`
// the rows of a thread that answered before main's chat held a row to stand under, until it holds one
const WAITING = 'waiting'
let signalsSaved: Promise<void> = Promise.resolve()

/** How a subagent ended, as Claude Code's row of its end says it, should one reach main's chat. */
function noticeWord(status: string | undefined): string {
  return status === 'killed' ? 'stopped' : status === 'failed' ? 'failed' : 'finished'
}

/** Main's turn ended: what waited for it starts, and the proposals are read again. */
async function mainEnded($: Dollar): Promise<void> {
  mainBusy = false
  for (const fn of afterMain.splice(0)) await fn().catch((err: unknown) => $.ui.log(`thimble-cc-mod: ${clip(String(err), 200)}`))
  await scanProposals($)
}

async function paths($: Dollar): Promise<void> {
  if (!root) root = $.plugin.root
  // the project root, which a shell `cd` does not move: a reload of the hooks after Claude cd'd into a folder would
  // otherwise take that folder for the corpus
  if (!cwd) cwd = await $.session.root().catch(() => $.session.cwd())
}

// ------------------------------------------------------------------------------------------------ the scripts' sandbox
//
// The scripts the mod runs itself (a card's script run again, a verification script, a view's checks, the file
// browser's helper, a label's run) run model-written code on a click, outside Claude Code's tools and so outside its
// sandbox. They run in the sandbox browser mode's kernels run in (hooks/sandbox.ts, helper/sandbox.py), planned once a
// session and kept here, never in .thimble-cc-mod/, which the scripts can write. So do the helpers that read or copy
// files there for the mod (a view's drawings for its reviewer, the copy of a view kept for its review), since a script
// can replace those files with links out of the folder.

let planned: Promise<SandboxPlan> | null = null
let unboxedSaid = false

/** This session's sandbox, planned on first use. */
function sandboxPlan($: Dollar): Promise<SandboxPlan> {
  planned ??= (async () => {
    await paths($)
    try {
      const r = await $.process.run(['python3', `${root}/helper/sandbox.py`, 'plan', '--cwd', cwd], { cwd, timeoutMs: 120000 })
      return parsePlan(r.stdout) ?? noPlan(r.stderr || r.stdout)
    } catch (err) {
      return noPlan(String(err))
    }
  })()
  return planned
}

/** Run one of the mod's own scripts in the sandbox: where none runs, as before, the transcript saying so once; where
 *  the sandbox THIMBLE_KERNEL_WRAP names cannot run, not at all, the result saying why. */
async function boxRun($: Dollar, argv: string[], init: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }> {
  const plan = await sandboxPlan($)
  if (plan.error) return { exitCode: 126, stdout: '', stderr: `thimble-cc-mod: ${plan.error}, so the script did not run`, isStdoutTruncated: false, isStderrTruncated: false }
  if (plan.wrap === 'none' && !unboxedSaid) {
    unboxedSaid = true
    $.ui.log(unboxedNotice(plan))
  }
  return $.process.run(boxedArgv(plan, argv), plan.wrap === 'none' ? init : { ...init, env: { ...(init.env ?? {}), ...plan.env } })
}

/** The guidance for main (prompt/chat.md), read once; the system prompt can be composed before session.start ends. */
async function ensureGuide($: Dollar): Promise<string> {
  if (guide) return guide
  await paths($)
  try {
    guide = (await $.fs.read(`${root}/prompt/chat.md`)).replaceAll('{{helper}}', `${root}/helper`)
  } catch {
    guide = ''
  }
  return guide
}

type CardFile = { data: CardData | null; error: string; why: string }

/** A card file, read again when it changed. `error` says why it cannot be drawn (missing, not JSON, off its spec) for
 *  main, with the card's id; `why` says it for the analyst, without the id. */
async function cardFile($: Dollar, id: string): Promise<CardFile> {
  await paths($)
  const file = `${cwd}/${HOME}/cards/${id}.json`
  let mtime = 0
  try {
    const st = await $.fs.stat(file)
    mtime = Number((st as { mtimeMs?: number }).mtimeMs ?? 0)
  } catch {
    return { data: null, error: `no card ${id} (${HOME}/cards/${id}.json)`, why: 'its card file was not written' }
  }
  const hit = cards.get(id)
  if (hit && hit.mtime === mtime) return hit
  let got: CardFile & { mtime: number }
  try {
    const raw = JSON.parse(await $.fs.read(file)) as unknown
    const why = validateCard(raw, id)
    got = why ? { mtime, data: null, error: `card ${id} does not validate: ${why}`, why } : { mtime, data: raw as CardData, error: '', why: '' }
  } catch {
    got = { mtime, data: null, error: `card ${id}: the file is not JSON`, why: 'its card file is not JSON' }
  }
  cards.set(id, got)
  return got
}

async function loadCard($: Dollar, id: string): Promise<CardData | null> {
  return (await cardFile($, id)).data
}

// when each label of the label tool last changed (.thimble-cc-mod/labels.json), read again when the file changes
let labelTimes: { mtime: number; at: Map<string, number> } = { mtime: -1, at: new Map() }

/** A card with each label its script read marked `stale` when the label changed after the card was made (an
 *  analyst's verdict, a new run), as thimble's stale label tag: the card's numbers may no longer be the label's. */
async function labelled($: Dollar, card: CardData): Promise<CardData> {
  if (!card.labels?.length) return card
  const made = Date.parse(String((card as { created?: unknown }).created ?? ''))
  if (!Number.isFinite(made)) return card
  const file = `${cwd}/${HOME}/labels.json`
  try {
    const mtime = Number(((await $.fs.stat(file)) as { mtimeMs?: number }).mtimeMs ?? 0)
    if (mtime !== labelTimes.mtime) {
      const at = new Map<string, number>()
      for (const x of JSON.parse(await $.fs.read(file)) as { slug?: unknown; updated?: unknown }[]) {
        if (x && typeof x.slug === 'string' && typeof x.updated === 'number') at.set(x.slug, x.updated * 1000)
      }
      labelTimes = { mtime, at }
    }
  } catch {
    return card
  }
  // the card's time is written to the second
  const labels = card.labels.map(l => ((labelTimes.at.get(l.slug) ?? 0) > made + 2000 ? { ...l, stale: true } : l))
  return labels.some(l => l.stale) ? { ...card, labels } : card
}

// ------------------------------------------------------------------------------------------------ card runs

async function metaOf($: Dollar, id: string): Promise<CardMeta> {
  const run = (await $.state.get({ ...RUNS, id })).value
  // a Client's props are plain data: no undefined values
  const meta: CardMeta = {}
  if (run?.busy) meta.busy = run.busy
  if (run?.error) meta.error = run.error
  return meta
}

// ------------------------------------------------------------------------------------------------ checking citations

const queue = new Map<string, Citation>()
let flushing = false

function remember(cs: Citation[]): void {
  for (const c of cs) known.set(cid(c.raw), c)
}

function rememberClaims(cls: Claim[]): void {
  for (const cl of cls) claimMap.set(cl.key, cl)
  remember(cls.map(cl => cl.c))
}

/** The citation a panel or a verification is keyed by: a claim's, or a citation's own (a mark's, a record's). */
function citeOf(key: string): Citation | undefined {
  return claimMap.get(key)?.c ?? known.get(key)
}

const CARD_OF = /^card:([A-Za-z0-9_-]+)/

/** The param values a card shows, as JSON, to compare with the ones its replies were written for. */
function paramsKey(card: CardData | null | undefined): string {
  return JSON.stringify(Object.fromEntries((card?.params ?? []).map(p => [p.name, String(p.value)])))
}

/** While the analyst's pick shows another choice of a card than its replies were written for: which, in words. */
async function otherChoice($: Dollar, ref: string): Promise<string> {
  const id = CARD_OF.exec(ref)?.[1]
  const run = id ? (await $.state.get({ ...RUNS, id })).value : undefined
  if (!id || !run?.written) return ''
  const now = (await loadCard($, id))?.params ?? []
  let was: Record<string, string> = {}
  try {
    was = JSON.parse(run.written) as Record<string, string>
  } catch {
    return ''
  }
  const diff = now.filter(p => p.name in was && String(p.value) !== was[p.name])
  if (!diff.length) return ''
  return `written for ${diff.map(p => `${p.name} = ${was[p.name]}`).join(', ')}; the card now shows ${diff.map(p => `${p.name} = ${p.value}`).join(', ')}`
}

/** Check citations with helper/resolve.py, one process for the batch, and keep each verdict in state. A citation of a
 *  card that shows another choice than its reply was written for keeps its verdict, unless `force` (a reply written
 *  now is checked against what the card shows now). */
async function check($: Dollar, all: Citation[], force = false): Promise<void> {
  const cs: Citation[] = []
  for (const c of all) if (force || !c.ref.startsWith('card:') || !(await otherChoice($, c.ref))) cs.push(c)
  if (cs.length === 0) return
  await paths($)
  const items = cs.map(c => ({ id: cid(c.raw), ref: c.ref, display: c.display, quote: quotes.get(cid(c.raw)) }))
  try {
    const r = await $.process.run(['python3', `${root}/helper/resolve.py`], {
      cwd,
      stdin: JSON.stringify({ cwd, items, around: 6 }),
      timeoutMs: 20000,
    })
    if (r.exitCode !== 0) {
      $.ui.log(`thimble-cc-mod: the resolver failed: ${r.stderr.trim().split('\n').at(-1) ?? ''}`)
      return
    }
    const out = JSON.parse(r.stdout) as (Omit<ChatVerdict, 'raw' | 'display' | 'id'> & { id: string })[]
    for (const v of out) {
      const c = known.get(v.id) ?? cs.find(x => cid(x.raw) === v.id)
      if (!c) continue
      const window = (v.window ?? []).map(w => capLine(w))
      await $.state.set({ ...VERDICTS, id: v.id }, { ...v, window, id: v.id, raw: c.raw, ref: c.ref, display: c.display })
    }
  } catch (err) {
    $.ui.log(`thimble-cc-mod: could not check citations: ${String(err).slice(0, 120)}`)
  }
}

/** Queue citations for a check soon after. A render may not write state, and a timer set from a render runs in the
 *  render's dispatch, so a timer started at session.start flushes the queue (flushQueue). */
function enqueue($: Dollar, cs: Citation[]): void {
  for (const c of cs) queue.set(cid(c.raw), c)
}

async function flushQueue($: Dollar): Promise<void> {
  if (flushing || queue.size === 0) return
  flushing = true
  const batch = [...queue.values()]
  queue.clear()
  try {
    await check($, batch)
  } finally {
    flushing = false
  }
}

/** What is wrong with a reply, for a fix round: cards it embeds that cannot be drawn, citations that fail. */
async function problemsOf($: Dollar, text: string): Promise<Problem[]> {
  const out: Problem[] = []
  for (const id of embeddedCards(text)) {
    const f = await cardFile($, id)
    if (f.error) out.push({ card: id, why: f.error })
  }
  const cs = citations(text)
  remember(cs)
  await check($, cs, true)
  for (const c of cs) {
    const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
    if (v?.status === 'missing') out.push({ cite: c, why: `does not resolve: ${v.why}` })
    else if (v?.status === 'differs') out.push({ cite: c, why: v.why })
  }
  return out
}

// ------------------------------------------------------------------------------------------------ the mod's subagents

/** Start a subagent of the mod, named `desc` (threads.tsx): a fork of main given `prompt`, so it has main's whole
 *  conversation, or where the fork is refused a general-purpose subagent given `fresh` (the guidance and the context),
 *  whose name then says so. A fork a plugin spawns ends without any notice to main; a general-purpose one hands its
 *  report back to main, which prompt.submit takes and drops. */
async function spawnSub($: Dollar, prompt: string, desc: string, fresh: string): Promise<{ agentId: string; engine: string } | { deny: string }> {
  // a fork inherits main's conversation, which does not yet hold the notes waiting for main's next prompt
  const fork = await $.agent.spawn({ prompt: withNotes(notes, prompt), description: desc, subagentType: 'fork' }).catch((err: unknown) => ({ deny: String(err) }))
  if (fork.deny === undefined && 'agentId' in fork && fork.agentId) return { agentId: fork.agentId, engine: 'fork' }
  await logEvent($, { event: 'fork refused', desc, why: clip(fork.deny ?? 'no id', 200) })
  const r = await $.agent.spawn({ prompt: withNotes(notes, fresh), description: fallbackName(desc), subagentType: 'general-purpose' }).catch((err: unknown) => ({ deny: String(err) }))
  if (r.deny !== undefined || !('agentId' in r) || !r.agentId) return { deny: r.deny ?? 'no id' }
  return { agentId: r.agentId, engine: 'general-purpose' }
}

/** Stop a subagent of the mod (TaskStop). One still running at /exit makes Claude Code ask whether to stop it or move
 *  the conversation to the background (claude agents), so each is stopped once its result is in, a side thread's
 *  also by its "stop", and any left before the session ends. */
async function endSub($: Dollar, agentId: string, why: string): Promise<boolean> {
  if (!agentId) return false
  const status = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)?.status
  if (status && status !== 'running' && status !== 'pending') {
    await logEvent($, { event: 'agent end', agent: agentId, why, result: `already ${status}` })
    return false
  }
  const r = await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch((err: unknown) => ({ deny: String(err), isError: undefined, text: undefined }))
  const result = r.deny !== undefined ? `refused: ${r.deny}` : r.isError ? `error: ${r.text ?? ''}` : 'stopped'
  await logEvent($, { event: 'agent end', agent: agentId, why, result: clip(result, 200) })
  return result === 'stopped'
}

/** Whether a text (a task notification) names a subagent of the mod by its id. */
async function modAgentIn($: Dollar, text: string): Promise<boolean> {
  const mine = (await $.agent.list().catch(() => [])).filter(a => a.spawnedBy === 'thimble-cc-mod')
  return mine.some(a => text.includes(a.id))
}

/** Stop the mod's subagents that still run, or only those `pick` keeps. Returns the ids it stopped. */
async function endRunning($: Dollar, why: string, pick?: (a: ChatAgent | undefined) => boolean): Promise<string[]> {
  const mine = (await $.agent.list().catch(() => [])).filter(a => a.spawnedBy === 'thimble-cc-mod')
  await logEvent($, { event: 'agents', why, list: mine.map(a => `${a.id} ${a.status}`).join(', ') || 'none' })
  const stopped: string[] = []
  for (const a of mine) {
    if (a.status !== 'running' && a.status !== 'pending') continue
    if ((!pick || pick(await agentOf($, a.id))) && (await endSub($, a.id, why))) stopped.push(a.id)
  }
  return stopped
}

/** How long /exit waits after the stopped subagents read as ended. Claude Code's exit check reads a list of running
 *  work that the screen publishes after it redraws, so a check made at once still lists a subagent just stopped. */
const EXIT_SETTLE_MS = 300

/** Wait until the subagents `ids` no longer read as running (at most 2 s), then for the screen to publish that. */
async function untilEnded($: Dollar, ids: string[]): Promise<void> {
  if (!ids.length) return
  const until = (await $.clock.now()) + 2000
  while ((await $.clock.now()) < until) {
    const live = (await $.agent.list().catch(() => [])).some(a => ids.includes(a.id) && (a.status === 'running' || a.status === 'pending'))
    if (!live) break
    await $.clock.sleep(50)
  }
  await $.clock.sleep(EXIT_SETTLE_MS)
  await logEvent($, { event: 'agents ended', list: ids.join(', ') })
}

/** A fix round's, a verification's, a writer's or a side thread's subagent ended: its answer (the report it handed
 *  back, else its last message) goes where its kind says. */
async function subAnswered($: Dollar, id: string, a: ChatAgent, reason: string, last: string): Promise<void> {
  const answer = handbacks.get(id) || last
  handbacks.delete(id)
  if (a.kind === 'fix') return fixComplete($, a, reason, answer)
  if (a.kind === 'verify') return verifyComplete($, a, answer)
  // a report's writer, verifier or highlighter; an orientation is a writer whose critique round may come first
  if ((await isOrient(harnessCtx($), id)) && (await orientEnded(harnessCtx($), id, reason))) return
  if (a.kind.startsWith('report')) return reportAgentDone(reportCtx($), a, reason, answer)
  const said = await threadComplete($, cwd, id, reason, answer)
  if (said) {
    const cs = citations(said)
    remember(cs)
    enqueue($, cs)
  }
}

async function agentOf($: Dollar, agentId: string | undefined): Promise<ChatAgent | undefined> {
  return agentId ? (await $.state.get({ ...AGENTS, id: agentId })).value : undefined
}

/** A note main reads with its next prompt and the analyst does not see, so its context matches the screen. */
async function noteMain($: Dollar, text: string): Promise<void> {
  notes.push(text)
  await saveNotes($)
}

async function saveNotes($: Dollar): Promise<void> {
  await paths($)
  const session = await $.session.id().catch(() => '')
  await $.fs.write(`${cwd}/${NOTES}`, JSON.stringify({ session, notes })).catch(() => undefined)
}

/** The notes this session left main that main has not read, from before a resume or a reload of the hooks. */
async function loadNotes($: Dollar): Promise<void> {
  await paths($)
  try {
    const got = JSON.parse(await $.fs.read(`${cwd}/${NOTES}`)) as { session?: unknown; notes?: unknown }
    if (got.session !== (await $.session.id().catch(() => '')) || !Array.isArray(got.notes)) return
    notes = [...new Set([...got.notes.filter((n): n is string => typeof n === 'string'), ...notes])]
  } catch {
    // none waiting
  }
}

/** The notes main has not read, handed over to go with its prompt. */
async function takeNotes($: Dollar): Promise<string[]> {
  const out = notes
  notes = []
  if (out.length) await saveNotes($)
  return out
}

// ------------------------------------------------------------------------------------------------ marks

async function saveMarks($: Dollar): Promise<void> {
  await paths($)
  const text = marksJson(marks)
  marksSaved = marksSaved.then(() => $.fs.write(`${cwd}/${MARKS}`, text)).catch(() => undefined)
  await marksSaved
}

async function setVerify($: Dollar, id: string, run: ChatVerify): Promise<void> {
  const ref = run.ref ?? citeOf(id)?.ref
  const v = ref ? { ...run, ref } : run
  await $.state.set({ ...VERIFY, id }, v)
  setMark(marks, 'verify', id, v)
  await saveMarks($)
}

/** An answer's end, by its last row; `last` when it is main's latest answer. */
async function setEnd($: Dollar, row: string, end: ChatEnd, last = false): Promise<void> {
  await $.state.set({ ...ENDS, id: row }, end)
  setMark(marks, 'ends', row, end)
  if (last) marks.last = row
  await saveMarks($)
}

/** The marks of earlier sessions in this folder, put in state where it holds none: after a resume every answer has its
 *  footer and each citation its ✓ or ✗ again (a reload of the hooks keeps the state it has). */
async function loadMarks($: Dollar): Promise<void> {
  await paths($)
  let got: Marks
  try {
    got = parseMarks(await $.fs.read(`${cwd}/${MARKS}`))
  } catch {
    return
  }
  marks = got
  for (const [id, end] of Object.entries(got.ends)) {
    const live = (await $.state.get({ ...ENDS, id })).value
    if (live) marks.ends[id] = live
    else await $.state.set({ ...ENDS, id }, end)
  }
  for (const [id, run] of Object.entries(got.verify)) {
    const live = (await $.state.get({ ...VERIFY, id })).value
    if (live) marks.verify[id] = live
    else await $.state.set({ ...VERIFY, id }, run)
  }
  for (const [id, fix] of Object.entries(got.fixes)) {
    const live = (await $.state.get({ ...FIXES, id })).value
    if (live) marks.fixes[id] = live
    else await $.state.set({ ...FIXES, id }, fix)
  }
}

// ------------------------------------------------------------------------------------------------ fix rounds

function fixKey(it: ChatFixItem): string[] {
  return it.card ? [`card-${it.card}`] : (it.keys ?? [])
}

async function setFix($: Dollar, items: ChatFixItem[], state: string, why?: string): Promise<void> {
  for (const it of items) {
    for (const id of fixKey(it)) {
      const fix = why ? { state, why } : { state }
      await $.state.set({ ...FIXES, id }, fix)
      setMark(marks, 'fixes', id, fix)
    }
  }
  await saveMarks($)
}

/** A reply's problems go to a subagent, out of main's chat; its citations spin until it answers. `rows` are the
 *  turn's text rows, so each passage's citations are known by their claims and its correction by its row. */
async function startFix($: Dollar, text: string, rows: ChatRow[], endRow: string, end: ChatEnd | undefined): Promise<void> {
  const problems = await problemsOf($, text)
  if (!problems.length) return
  const items = fixItems(text, problems)
  for (const it of items) {
    if (it.card) continue
    it.keys = rows.filter(r => r.text.includes(it.old)).flatMap(r => claimsIn(r.text, r.id).filter(cl => it.cites.includes(cl.c.raw)).map(cl => cl.key))
  }
  await setFix($, items, 'fixing')
  const prompt = fixPrompt(items)
  const label = fixName(items)
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), `${prompt}\n\nThe reply:\n${text}`))
  if ('deny' in r) {
    await setFix($, items, 'failed', `could not start a subagent: ${r.deny}`)
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'fix', label, items, reply: text, endRow, rows, ...(end ? { end } : {}) })
}

/** The fix round answered: each corrected sentence that now checks replaces the old one; the others stay red, ✗. */
async function fixComplete($: Dollar, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const items = a.items ?? []
  const got = reason === 'answer' ? parseFix(answer, items.length) : items.map(() => ({ ok: false as const, why: `the fix ended: ${reason}` }))
  const fresh = got.flatMap(g => (g.ok ? citations(g.text) : []))
  remember(fresh)
  await check($, fresh, true)
  const verdicts = new Map<string, ChatVerdict | undefined>()
  for (const c of fresh) verdicts.set(c.raw, (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value)
  const cardErrors = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const id = items[i]!.card ? fixedCard(items[i]!, got[i]!) : ''
    if (id) cardErrors.set(id, (await cardFile($, id)).error)
  }
  const out = settleFix(items, got, raw => verdicts.get(raw), id => cardErrors.get(id) ?? '', a.reply)
  for (let i = 0; i < items.length; i++) {
    const st = out.states[i]!
    await setFix($, [items[i]!], st.state, st.why)
  }
  if (a.thread) return threadFixed($, a, out.corrections, out.notes)
  const at = await $.clock.now()
  // each correction is for the row its passage stands in, and is drawn there only
  const rows = a.rows ?? []
  const made: ChatCorrection[] = out.corrections.map(c => ({ ...c, at, row: rows.find(r => r.text.includes(c.old))?.id ?? a.endRow ?? '' }))
  const notes = out.notes
  // a card's script may have changed values the reply cites
  const fixedRows = rows.map(r => ({ id: r.id, text: applyCorrections(r.text, made, r.id) }))
  const cls = fixedRows.flatMap(r => claimsIn(r.text, r.id))
  rememberClaims(cls)
  await check($, cls.map(cl => cl.c).filter(c => c.ref.startsWith('card:')), true)
  if (made.length) {
    const all = await update($, correctionsA, list => [...(list ?? []), ...made].slice(-200))
    await paths($)
    await $.fs.write(`${cwd}/${HOME}/corrections.json`, JSON.stringify(all, null, 1)).catch(() => undefined)
    // the answer file is written again from the answer as written and its corrections, whatever state was lost
    const end = (a.endRow ? (await $.state.get({ ...ENDS, id: a.endRow })).value : undefined) ?? a.end
    if (end) {
      await $.fs.write(`${cwd}/${end.file}`, answerFile(end, all)).catch(() => undefined)
      if (a.endRow) await setEnd($, a.endRow, end)
    }
    const turn = await read($, turnA)
    if (turn && turn.ids.some(id => fixKeysOf(items).has(id))) await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { ...turn, ids: cls.map(cl => cl.key) })
  }
  if (notes.length) await noteMain($, ['thimble-cc-mod checked your last reply, and a subagent worked on its problems; the analyst sees the result in place:', ...notes.map(n => `- ${n}`)].join('\n'))
}

function fixKeysOf(items: ChatFixItem[]): Set<string> {
  return new Set(items.flatMap(fixKey))
}

async function loadCorrections($: Dollar): Promise<void> {
  if ((await read($, correctionsA))?.length) return
  await paths($)
  try {
    const list = JSON.parse(await $.fs.read(`${cwd}/${HOME}/corrections.json`)) as ChatCorrection[]
    // a correction without the row it was made for cannot be put back in the right answer
    if (Array.isArray(list)) await $.state.set(CORRECTIONS, list.filter(c => typeof c?.old === 'string' && typeof c?.new === 'string' && typeof c?.row === 'string' && c.row !== ''))
  } catch {
    // no corrections in this folder
  }
}

// ------------------------------------------------------------------------------------------------ verification scripts

function scriptPath(id: string): string {
  return `${HOME}/verify/v-${id}.py`
}

function verifyPrompt(c: Citation, v: ChatVerdict | undefined, sentence: string, script: string): string {
  const where =
    v?.kind === 'value'
      ? `row "${v.row}" of column "${v.column}" of card:${v.card}`
      : v?.kind === 'call'
        ? `line ${v.start} of the output of call:${v.call}`
        : v?.file
          ? `${v.file}${v.start ? ` line ${v.start}` : ''}`
          : c.ref
  // words that show no value leave the script nothing to print but the place of its records, which the mod compares
  const place = c.display !== null && !showsValue(c.display) && citedPlace(c.ref) ? [`"${c.display}" names a place, not a value: the script ${scriptAim(c.display, c.ref)}.`] : []
  return [
    `thimble-cc-mod: the analyst asks for a verification script of ${c.raw} (${where}), from the sentence "${clip(sentence || c.raw, 300)}". Recompute what that sentence claims.`,
    ...place,
    `Write it at ${script}, following "Verification scripts" in thimble-cc-mod's guidance, run it once, and reply in one sentence with what it recomputed.`,
  ].join('\n')
}

/** A subagent writes the verification script of a claim (`id`: its key; a mark's or a record's citation id), out
 *  of main's chat; its end runs the script. */
async function askVerify($: Dollar, id: string): Promise<void> {
  const c = citeOf(id)
  if (!c) return
  const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
  const script = scriptPath(id)
  await setVerify($, id, { id, state: 'asked', script, expected: c.display })
  const prompt = verifyPrompt(c, v, claimMap.get(id)?.sentence ?? '', script)
  const label = verifyName(chipLabel(c))
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), prompt))
  if ('deny' in r) {
    await setVerify($, id, { id, state: 'error', script, expected: c.display, stderr: `could not start a subagent: ${r.deny}` })
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'verify', label, cite: id })
}

/** The verification's subagent ended: the mod runs the script it wrote (never the subagent's copy of its output). */
async function verifyComplete($: Dollar, a: ChatAgent, answer: string): Promise<void> {
  const id = a.cite ?? ''
  const prev = (await $.state.get({ ...VERIFY, id })).value
  if (!prev) return
  await paths($)
  if (await $.fs.exists(`${cwd}/${prev.script}`)) await runVerify($, id)
  else await setVerify($, id, { ...prev, state: 'missing', stderr: clip(answer, 500) })
}

/** Run a citation's verification script (never main's copy of its output) and record what it printed. */
async function runVerify($: Dollar, id: string): Promise<void> {
  await paths($)
  const prev = (await $.state.get({ ...VERIFY, id })).value
  const c = citeOf(id)
  const script = prev?.script ?? scriptPath(id)
  const expected = prev?.expected ?? c?.display ?? null
  const ref = c?.ref ?? prev?.ref
  let source = ''
  try {
    source = await $.fs.read(`${cwd}/${script}`)
  } catch {
    await setVerify($, id, { id, state: 'missing', script, expected, ref })
    return
  }
  await setVerify($, id, { id, state: 'running', script, expected, ref, source: source.slice(0, 9000) })
  try {
    const r = await boxRun($, ['python3', script], { cwd, timeoutMs: 180000 })
    const result = scriptResult(r.stdout)
    const ok = r.exitCode === 0 && result !== null && verifyMatches(expected, ref, result)
    await setVerify($, id, {
      id,
      script,
      expected,
      ref,
      source: source.slice(0, 9000),
      stdout: r.stdout.slice(-4000),
      stderr: r.stderr.slice(-2000),
      exitCode: r.exitCode,
      result,
      ranAt: await $.clock.now(),
      state: r.exitCode !== 0 || result === null ? 'error' : ok ? 'verified' : 'refuted',
    })
    if (r.exitCode === 0 && result !== null && c) {
      const sentence = claimMap.get(id)?.sentence
      await noteMain($, `thimble-cc-mod: the verification script ${script} recomputed ${result} for ${c.raw}${sentence ? ` in "${clip(sentence, 200)}"` : ''}${expected === null ? '' : ok ? ', which matches' : `, not ${citedAs(expected, ref)}`}.`)
    }
  } catch (err) {
    await setVerify($, id, { id, state: 'error', script, expected, ref, source: source.slice(0, 9000), stderr: String(err).slice(0, 500) })
  }
}

/** Why a verification that ended in `error` failed: it crashed, printed no result, or never started. */
function verifyError(run: ChatVerify): string {
  const last = (run.stderr ?? '').trim().split('\n').at(-1) ?? ''
  if (!run.source) return `failed: ${clip(run.stderr || 'the script could not be read', 300)}`
  if (run.exitCode === undefined) return `crashed: the script could not run${last ? ` (${clip(last, 160)})` : ''}`
  if (run.exitCode !== 0) return `crashed: the script exited with ${run.exitCode}${last ? ` (${clip(last, 160)})` : ''}`
  return 'failed: the script printed no RESULT line'
}

function verifyWords(run: ChatVerify | undefined): string {
  if (!run) return ''
  if (run.kind === 'support') return run.state === 'asked' ? 'being read' : run.state === 'verified' ? 'supports the sentence' : run.state === 'refuted' ? 'does not support the sentence' : run.state === 'missing' ? 'not judged' : ''
  switch (run.state) {
    case 'verified':
      return `script recomputed ${run.result}`
    case 'refuted':
      return `script recomputed ${run.result}, not ${citedAs(run.expected, run.ref)}`
    case 'error':
      return run.source ? 'script crashed' : 'script failed to start'
    case 'asked':
      return 'script being written'
    case 'running':
      return 'script running'
    case 'missing':
      return 'script not written'
    default:
      return ''
  }
}

// ------------------------------------------------------------------------------------------------ card scripts

/** Run a card's script again (a param picked, or "rerun"): only that card is written, under its own id. */
async function rerunCard($: Dollar, id: string, change?: { name: string; value: string }): Promise<void> {
  await paths($)
  const card = await loadCard($, id)
  const script = card?.source?.script
  const prev = (await $.state.get({ ...RUNS, id })).value ?? { rev: 0 }
  if (!card || !script) {
    $.ui.toast('this card has no script to run')
    return
  }
  if (prev.busy) return
  const values: Record<string, string | number> = {}
  for (const p of card.params ?? []) values[p.name] = p.value
  if (change) values[change.name] = change.value
  // a choice changes what the card shows, not what its replies claimed: they keep the choice they were written for
  const written = prev.written ?? (change ? paramsKey(card) : undefined)
  const keep = written ? { written } : {}
  await $.state.set({ ...RUNS, id }, { ...prev, ...keep, busy: change ? `running with ${change.name} = ${change.value}…` : 'running…', error: undefined })
  try {
    const r = await boxRun($, ['python3', script], {
      cwd,
      env: { THIMBLE_CC_MOD_PARAMS: JSON.stringify(values), THIMBLE_CC_MOD_ONLY: `${card.source.index ?? 0}:${id}`, THIMBLE_CC_MOD_ROOT: cwd },
      timeoutMs: 180000,
    })
    const f = await cardFile($, id)
    const error = r.exitCode !== 0 ? `the script exited with ${r.exitCode}: ${r.stderr.trim().split('\n').at(-1) ?? ''}` : f.error
    // back at the choice the replies were written for, the card is theirs again
    const still = written && paramsKey(f.data) !== written ? { written } : {}
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, ...still, error: error || undefined, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-2000), exitCode: r.exitCode, at: await $.clock.now() })
  } catch (err) {
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, ...keep, error: `could not run ${script}: ${String(err).slice(0, 100)}` })
  }
  // the citations of this card are checked again (the script may have changed its values), but not while the card
  // shows another choice than they were written for (check keeps their verdicts then)
  const mine = [...known.values()].filter(c => c.ref.startsWith(`card:${id}#`) || c.ref === `card:${id}`)
  if (mine.length) await check($, mine)
}

/** What a card's script printed, without the card helper's lines for main (where the card went, how to embed and cite
 *  it): the analyst reads the script's own output. */
function scriptOutput(stdout: string): string {
  const out: string[] = []
  let listing = false
  for (const line of stdout.split('\n')) {
    if (/^thimble-cc-mod(?: card |:)|^controls on the card: |^embed it on a line of its own: /.test(line)) {
      listing = false
      continue
    }
    if (/^cite its (?:values|records) as:$/.test(line)) {
      listing = true
      continue
    }
    if (listing && /^ {2}(?:\[\[|\.\.\. \d+ more)/.test(line)) continue
    listing = false
    out.push(line)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------------------------------------ side threads

async function saveThread($: Dollar, cwd: string, t: ChatThread): Promise<void> {
  try {
    await $.fs.write(`${cwd}/${t.file}`, threadFile(t))
    // the thread as data beside its file, so the threads list can reopen and continue it in a later session
    await $.fs.write(`${cwd}/${t.file.replace(/\.md$/, '.json')}`, threadJson(t))
  } catch {
    // the thread stays in the pane
  }
}

/** Every side thread: this session's, then those saved in earlier sessions (their .json beside the .md), newest
 *  first, at most 50. */
async function allThreads($: Dollar): Promise<ChatThread[]> {
  await paths($)
  const out = new Map<string, ChatThread>()
  for (const id of [...((await read($, threadListA)) ?? [])].reverse()) {
    const t = await getThread($, id)
    if (t) out.set(t.id, t)
  }
  let saved: { name: string; mtimeMs: number }[] = []
  try {
    saved = (await $.fs.list(`${cwd}/${HOME}/threads`)).filter(f => f.name.endsWith('.json'))
  } catch {
    saved = []
  }
  for (const f of saved.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50)) {
    const id = f.name.replace(/\.json$/, '')
    if (out.has(id)) continue
    try {
      const t = parseThread(await $.fs.read(`${cwd}/${HOME}/threads/${f.name}`))
      if (t) out.set(t.id, t)
    } catch {
      // a file that does not read is left out
    }
  }
  return [...out.values()].slice(0, 50)
}

/** Show a thread in the panel, one saved in an earlier session put back into this session's state first, under the
 *  threads it was asked from; back leads to what the panel showed. */
async function showThread($: Dollar, t: ChatThread): Promise<void> {
  if (!(await getThread($, t.id))) await setThread($, t)
  const list = (await read($, threadListA)) ?? []
  if (!list.includes(t.id)) await $.state.set({ plugin: 'thimble-cc-mod', key: 'threadList' }, [...list, t.id].slice(-20))
  const nav = (await read($, navA)) ?? NAV_EMPTY
  await navGo($, { trail: await threadSteps($, t.id), back: withBack(nav.back, nav.trail) })
}

async function setThread($: Dollar, t: ChatThread): Promise<void> {
  await $.state.set({ ...THREADS, id: t.id }, t)
}

async function getThread($: Dollar, id: string): Promise<ChatThread | undefined> {
  return id ? (await $.state.get({ ...THREADS, id })).value : undefined
}

/** Open a thread by its id (a passage's "↳", a "↳ thread" row), one of an earlier session read back first. */
async function threadById($: Dollar, id: string): Promise<void> {
  const t = await threadOrSaved($, id)
  if (t) await showThread($, t)
}

/** Open a side thread about something on the screen; the pane takes the keys, its field asks the first question.
 *  `passage`: the key of the passage it is about (passageOf), whose margin shows its "↳" from then on. */
async function openThread($: Dollar, about: { label: string; context: string; ref?: string; passage?: string }): Promise<string> {
  // the time, and a count, so two threads started in one millisecond do not share an id
  const now = await $.clock.now()
  const id = `t${now.toString(36)}${(++threadSeq).toString(36)}`
  // asked from inside the panel, it hangs under the thread the panel's trail holds (hooks/nav.ts)
  const parent = (await navInPanel($)) ? threadOnTrail(((await read($, navA)) ?? NAV_EMPTY).trail) : ''
  const t: ChatThread = { id, label: about.label, ref: about.ref ?? '', context: about.context, agentId: '', engine: '', turns: [], file: `.thimble-cc-mod/threads/${id}.md`, ...(parent ? { parent } : {}), ...(about.passage ? { passage: about.passage } : {}), at: now }
  if (about.passage) passageThreads.set(about.passage, id)
  await setThread($, t)
  await setSeen($, id, 0)
  const list = (await read($, threadListA)) ?? []
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'threadList' }, [...list, id].slice(-20))
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'thread' }, id)
  await openPane($, 'thread', 'Threads')
  return id
}

/** Ask the thread's subagent a question: the first starts it, a follow-up is sent to it. */
async function askThread($: Dollar, id: string, q: string, guide: string): Promise<void> {
  const t0 = await getThread($, id)
  if (!t0 || !q.trim()) return
  if (t0.turns.at(-1)?.state === 'running') {
    $.ui.toast('the side thread is still answering')
    return
  }
  const t: ChatThread = { ...t0, turns: [...t0.turns, { q: q.trim(), a: '', state: 'running', tools: 0, partial: '' }], at: await $.clock.now().catch(() => t0.at ?? 0) }
  await setThread($, t)
  await paths($)
  await saveThread($, cwd, t)
  // Each question starts a fresh subagent that carries the exchange so far.
  const label = threadName(q)
  const r = await spawnSub($, forkPrompt(t, q.trim()), label, freshPrompt(t, q.trim(), guide))
  if ('deny' in r) {
    await setThread($, lastTurn(t, { state: 'error', a: `could not start a subagent: ${r.deny}` }))
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'thread', label, thread: id })
  await setThread($, { ...t, agentId: r.agentId, engine: r.engine })
}

/** A side thread the panel no longer shows: its question says it stopped, then its subagent still answering stops
 *  (in that order, so the subagent's end finds the turn no longer running and leaves it: threadComplete). */
async function endThread($: Dollar, tid: string, why: string): Promise<void> {
  const t = await getThread($, tid)
  if (t?.turns.at(-1)?.state === 'running') {
    const done = lastTurn(t, { state: 'error', a: `stopped: ${why}` })
    await setThread($, done)
    await paths($)
    await saveThread($, cwd, done)
  }
  await endRunning($, why, a => a?.kind === 'thread' && a.thread === tid)
}

// A side thread answers on when the panel moves on or closes: the breadcrumb and the threads tree show it answering
// and its answer unread, its "stop" ends it (endThread), and /exit ends every subagent.

/** A subagent's row: a thread's progress (its tool calls and latest text). Called by register.tsx's one
 *  session.append hook (an event takes one hook per matcher). */
async function threadAppend($: Dollar, agentId: string | undefined, door: string, content: unknown): Promise<void> {
  if (door !== 'response' || !Array.isArray(content)) return
  const a = await agentOf($, agentId)
  const tid = a?.kind === 'thread' ? a.thread : undefined
  if (!tid) return
  const blocks = content as { type?: string; text?: string }[]
  const tools = blocks.filter(b => b.type === 'tool_use').length
  const text = withoutTaskLine(blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')).trim()
  const t = await getThread($, tid)
  const cur = t?.turns.at(-1)
  if (t && cur?.state === 'running' && (tools || text)) {
    await setThread($, lastTurn(t, { tools: cur.tools + tools, partial: text ? clip(text, 300) : cur.partial }))
  }
}

/** The Bash outputs of a subagent, each saved under .thimble-cc-mod/calls/ as the tool.call hook saves main's (the
 *  hook's note with the id does not reach a side thread's fork), so a citation of one resolves. */
async function subCalls($: Dollar, agentId: string): Promise<ThreadCall[]> {
  const rows = await $.session.messages({ agentId }).catch(() => [])
  if (!Array.isArray(rows)) return []
  const out: ThreadCall[] = []
  for (const u of rows.flatMap(r => r.toolUses)) {
    if (u.tool !== 'Bash' || u.isError || !u.text?.trim()) continue
    const id = cid(u.tool_use_id)
    const file = `${cwd}/${HOME}/calls/${id}.json`
    if (!(await $.fs.exists(file).catch(() => false))) {
      const ok = await $.fs.write(file, JSON.stringify({ id, tool_use_id: u.tool_use_id, command: String(u.input.command ?? ''), output: u.text })).then(() => true, () => false)
      if (!ok) continue
    }
    out.push({ id, output: u.text })
  }
  return out
}

/** A subagent's turn.complete: a thread's answer, saved to its file. Returns the answer's text, or null when the
 *  subagent was not a thread's. */
async function threadComplete($: Dollar, cwd: string, agentId: string, reason: string, answer: string): Promise<string | null> {
  const a = await agentOf($, agentId)
  const tid = a?.kind === 'thread' ? a.thread : undefined
  if (!tid) return null
  const t = await getThread($, tid)
  // a turn stopped with the panel (endThread) keeps saying so
  if (!t || t.turns.at(-1)?.state !== 'running') return null
  // its citations of its own Bash outputs pointed at them, and the line restating its task dropped
  const calls = /\|\s*call:/.test(answer) ? await subCalls($, agentId) : []
  const saved = new Set(calls.map(c => c.id))
  for (const m of answer.matchAll(/\|\s*call:([A-Za-z0-9_-]+)/g)) if (await $.fs.exists(`${cwd}/${HOME}/calls/${m[1]}.json`).catch(() => false)) saved.add(m[1]!)
  const said = withoutTaskLine(pinCalls(answer, calls, id => saved.has(id)))
  const text = reason === 'answer' ? said : `${said || ''}\n(the subagent ended: ${reason})`.trim()
  const done = { ...lastTurn(t, { a: text, state: reason === 'answer' ? 'done' : 'error' }), at: await $.clock.now().catch(() => t.at ?? 0) }
  await setThread($, done)
  await seenIfShown($, done)
  await saveThread($, cwd, done)
  // main is told, out of sight, so it can speak of the thread when the analyst asks
  if (reason === 'answer' && text.trim()) await noteMain($, threadNote(t, t.turns.at(-1)!.q, text))
  // a thread about a card may have run its script again: a new rev redraws the card where it stands, and every
  // citation of its values is checked again, so one the change made stale turns red
  const card = /^\[\[card:([A-Za-z0-9_-]+)\]\]$/.exec(t.ref)?.[1]
  if (card) {
    const prev = (await $.state.get({ ...RUNS, id: card })).value ?? { rev: 0 }
    await $.state.set({ ...RUNS, id: card }, { ...prev, rev: prev.rev + 1, at: await $.clock.now() })
    enqueue($, [...known.values()].filter(c => c.ref.startsWith(`card:${card}#`)))
    void flushQueue($)
  }
  // the panel shows the answer; a citation of it that fails goes to a fix round, like main's
  if (reason === 'answer' && text.trim()) await startThreadFix($, done)
  return text
}

/** A side thread's answer with red citations or a card that cannot be drawn goes to a fix round, out of main's chat:
 *  its citations spin until the round answers, and each corrected sentence replaces the old one in the thread. */
async function startThreadFix($: Dollar, t: ChatThread): Promise<void> {
  const k = t.turns.length
  const body = threadBody(t.turns[k - 1]?.a ?? '')
  const problems = await problemsOf($, body)
  if (!problems.length) return
  const items = fixItems(body, problems)
  // the claims as the panel draws them (drawThread): the answer named by the thread and the turn
  const cls = claimsIn(body, `${t.id}:${k}`)
  rememberClaims(cls)
  for (const it of items) if (!it.card) it.keys = cls.filter(cl => it.cites.includes(cl.c.raw)).map(cl => cl.key)
  await setFix($, items, 'fixing')
  const prompt = fixPrompt(items, body)
  const label = fixName(items)
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), prompt))
  if ('deny' in r) {
    await setFix($, items, 'failed', `could not start a subagent: ${r.deny}`)
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'fix', label, items, reply: body, thread: t.id, turn: k })
}

/** A side thread's fix round answered: each correction put in the thread's answer, where the panel draws it. */
async function threadFixed($: Dollar, a: ChatAgent, made: { old: string; new: string }[], said: string[]): Promise<void> {
  const t = a.thread ? await getThread($, a.thread) : undefined
  const k = a.turn ?? 0
  const turn = t?.turns[k - 1]
  if (!t || !turn) return
  const text = correctText(turn.a, made)
  if (text !== turn.a) {
    const turns = t.turns.slice()
    turns[k - 1] = { ...turn, a: text }
    const fixed = { ...t, turns }
    await setThread($, fixed)
    await paths($)
    await saveThread($, cwd, fixed)
    const cls = claimsIn(threadBody(text), `${t.id}:${k}`)
    rememberClaims(cls)
    enqueue($, cls.map(cl => cl.c))
  }
  if (said.length) await noteMain($, [`thimble-cc-mod checked a side thread's answer (${t.file}), and a subagent worked on its problems; the analyst sees the result in the panel:`, ...said.map(n => `- ${n}`)].join('\n'))
}

// ------------------------------------------------------------------------------------------------ chips

/** How a citation in the prompt is painted: as a link, like the reply's, blue and underlined. */
function chipDecoration(raw: string, start = 0): { start: number; end: number; underline: boolean; color: string } {
  return { start, end: start + raw.length, underline: true, color: LINK }
}

/** What a citation's fix round says while it runs, or after it failed on a citation that is still red. */
function fixNote(status: string | undefined, fix: { state: string; why?: string } | undefined): string {
  const st = chipState(status, fix?.state)
  if (st === 'fixing') return '◌ being fixed'
  if (st === 'failed') return `the fix failed: ${plainWhy(fix?.why ?? 'no reason given')}`
  return ''
}

/** A card by its question, never its id. */
function cardName(id: string): string {
  const q = cards.get(id)?.data?.question
  return q ? `card "${clip(q, 40)}"` : 'the card'
}

/** A ref as the analyst reads it: a card's place by the card's question and a command's output by its line, never an
 *  id; any other place as written. */
function placeName(ref: string): string {
  const m = /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(ref)
  if (m) return m[2] ? `${cardName(m[1]!)} · ${m[2]}` : cardName(m[1]!)
  const call = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref)
  if (call) return `a command's output${call[1] ? ` · line ${call[1]}${call[2] ? `-${call[2]}` : ''}` : ''}`
  return placeWords(ref)
}

/** A pasted citation of card `id` as its pane names it: the value and its place on the card; '' for any other. */
function citedOnCard(raw: string, id: string): string {
  const c = citations(raw)[0]
  const m = c && /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(c.ref)
  if (!c || m?.[1] !== id) return ''
  const place = m[2] ? m[2].replace('/', ' ') : 'the card'
  return c.display !== null ? `${c.display} · ${place}` : place
}

/** A reason as the analyst reads it: citations as their shown words, a card by its question, a command's output
 *  without its id. */
function plainWhy(why: string): string {
  return plainCites(why)
    .replace(/\bcard[: ]([A-Za-z0-9_-]+)/g, (m, id: string) => (cards.has(id) || /^[0-9a-f]{6}$/.test(id) ? cardName(id) : m))
    .replace(/\bcall[: ](?=[a-z]*\d)[0-9a-z]{3,8}\b/g, 'the command')
    .replace(new RegExp(`${HOME.replace('.', '\\.')}/cards/[A-Za-z0-9_-]+\\.json`, 'g'), 'its card file')
}

async function chipView($: Dollar, cl: Claim): Promise<ChipView> {
  const c = cl.c
  const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
  const run = (await $.state.get({ ...VERIFY, id: cl.key })).value
  const fix = (await $.state.get({ ...FIXES, id: cl.key })).value
  const look = chipLook(v?.status, fix?.state, run?.state)
  // the tip in plain words: where the value was found (or not), what a script got; why, for a problem
  const problem = v?.status === 'missing' || v?.status === 'differs'
  const tip = [statusWords(c, v, v?.status ?? 'pending', run), problem ? plainWhy(v?.why ?? '') : '', await otherChoice($, c.ref), fixNote(v?.status, fix)].filter(Boolean).join(' · ')
  return { label: citeLabel(c), ...look, tip }
}

/** A line of text as segments, each citation as a link (its shown words, blue and underlined), the rest styled
 *  `base`. */
function linkSegs(text: string, base: Omit<Line[number], 's'>): Line {
  return inlineRuns(text.replace(/\s+/g, ' ')).map(r => (r.cite ? linkSeg(citeLabel(r.cite)) : { ...base, s: r.text }))
}

/** Markdown as Claude Code draws it (views/SPEC.md, "The visual system", rule 13): the model's `**bold**`, headings and
 *  inline code drawn as in any reply, so the text is handed over as written. */
export function plainMarkdown(md: string): string {
  return md
}

// ------------------------------------------------------------------------------------------------ drawing a reply

/** The columns at the left of each block of a reply: ⏺, a space, the reply's margin (the "?" shown on hover, a
 *  passage's ↳), a space (views/SPEC.md, "The visual system", "The chat column"). Headings sit on the text column. */
const MARGIN = 4
/** A reply's margin in the panel (a report, a side thread's answer): its marks at M, its text at A0. */
const PANEL_MARGIN = 2

// the thread asked about each passage, by the passage's key (report.ts passageKey): its "↳" in the reply's margin
const passageThreads = new Map<string, string>()
let passagesRead = false

/** A passage's key, as a thread asked about it keeps it. */
function passageOf(words: string): string {
  return passageKey(words).slice(0, 300)
}

/** The threads of earlier sessions read once, so their passages show their "↳" after a resume. */
async function loadPassages($: Dollar): Promise<void> {
  if (passagesRead) return
  passagesRead = true
  for (const t of await allThreads($)) if (t.passage && !passageThreads.has(t.passage)) passageThreads.set(t.passage, t.id)
}

/** A reply's blocks as thimble-cc-mod draws them: Markdown as the engine would, cards as panels, paragraphs that hold
 *  citations as chips. Interactive (Clients) on the terminal and desktop, static elsewhere. `answer` names the answer
 *  (a row's uuid, a side thread's turn): each citation is checked as the claim of its sentence in it. */
async function drawReply($: Dollar, e: ResolveInput, text: string, width: number, answer: string, prefix = '', first = false, opts: ReplyOpts = {}): Promise<RenderElement[]> {
  const { Box, Text, Markdown, Button } = $.ui.resolve(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  if (live) await loadPassages($).catch(() => undefined)
  // `width`: the columns a block may take, right of the margin; a card is laid out for them and no wider
  const cols = Math.max(24, width)
  const out: RenderElement[] = []
  const blocks = parseReply(text)
  let n = 0
  let order = 0 // the card's place among the reply's cards, its name for the analyst ("Card 2")
  // Each block is a row: a margin of MARGIN columns (the reply's ⏺ on its first, a space, then the margin's mark and a
  // space) and the block. On a live surface the margin holds a "?", blue, shown while the pointer is on the block: a
  // side thread about the block, or for a heading about its whole section, for a card about the card. It is a Button
  // in the row's own flow, so a press reaches it (an absolute one outside the row would be the margin's) and is the
  // person's own: the panel opens at any width. Once a thread was asked about the passage, a blue "↳" stays there in
  // its place, and a click on it opens that thread.
  let lead = first ? '⏺' : ' '
  // the columns left of the text: a reply's MARGIN, a panel's PANEL_MARGIN (its text at A0, its marks at M)
  const M = opts.margin ?? MARGIN
  type Ask = { key: string; askKey: string; press: () => void; passage: string; top?: number; bar?: string }
  const markOf = (ask: Ask | undefined): RenderElement | null => {
    if (!ask || !live) return null
    const tid = passageThreads.get(ask.passage)
    if (tid) return linesEl($, e as PaneEvent, `pmark:${ask.askKey}`, [[{ s: '↳', fg: LINK }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => threadById($, tid) }], 1)
    return (
      <Box width={1} display="none" hover={{ display: 'flex' }}>
        <Button key={ask.askKey} label="?" plain hover={{ color: LINK }} onPress={ask.press} />
      </Box>
    )
  }
  const row = (el: RenderElement, ask?: Ask) => {
    const mark = lead
    lead = ' '
    const qmark = markOf(ask)
    const content = (
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {el}
      </Box>
    )
    // a panel's margin: a highlight set's ●, the ↳ or the "?" at M, the text at A0
    if (M !== MARGIN)
      return (
        <Box {...(ask ? { key: ask.key } : {})} flexDirection="row">
          <Box width={M} flexShrink={0} flexDirection="row" marginTop={ask?.top ?? 0}>
            {ask?.bar ? <Text color={ask.bar}>●</Text> : (qmark ?? <Text> </Text>)}
          </Box>
          {content}
        </Box>
      )
    return (
      <Box {...(ask ? { key: ask.key } : {})} flexDirection="row">
        <Box width={MARGIN} flexShrink={0} flexDirection="row" marginTop={ask?.top ?? 0}>
          <Box width={2} flexShrink={0} flexDirection="row">
            <Text>{mark}</Text>
          </Box>
          {qmark}
        </Box>
        {content}
      </Box>
    )
  }
  // a blank row before a block that had a blank line before it, but none next to a card: its border stands in for one
  // (views/SPEC.md, rule 11)
  const push = (el: RenderElement, ask?: Ask) => {
    const r = row(el, ask)
    const before = blocks[n - 2]
    // and none under a heading: it belongs to what follows it (views/SPEC.md, "Main's chat")
    const underHead = (before?.type === 'rich' && before.heading > 0) || (before?.type === 'md' && /^#{1,6}\s/.test(before.text.split('\n').at(-1)!.trim()))
    const gap = blocks[n - 1]?.gap && !underHead && blocks[n - 1]?.type !== 'card' && !(before?.type === 'card' && !before.caption)
    out.push(gap ? <Box marginTop={1}>{r}</Box> : r)
  }
  const secs = sectionsOf(text)
  // a report's drawing (reports.tsx ReplyOpts): where each passage stands, told to its thread; a heading's controls;
  // a highlighted passage's bar and the rows under it
  let heading = ''
  const where = (h: string) => opts.where?.(h) ?? ''
  const about = (words: string) => {
    const first = words.split('\n')[0]!.trim()
    const head = /^#{1,6}\s/.test(first) ? [...secs.keys()].find(k => k === first || plainCites(k) === plainCites(first)) : undefined
    const sec = head ? secs.get(head) : undefined
    const at = where(head ? first : heading)
    const passage = passageOf(words)
    return sec
      ? () => void openThread($, { label: `the section "${clip(plainCites(first.replace(/^#+\s*/, '')), 60)}"`, context: [at, `The section of the reply the analyst asks about:\n${clip(sec, 4000)}`].filter(Boolean).join('\n'), passage })
      : () => void threadOn($, { kind: 'sentence', text: words.slice(0, 1200) }, at, passage)
  }
  const tooled = (el: RenderElement, words: string) => {
    const tool = opts.tools && /^#{1,6}\s/.test(words) ? opts.tools(words.split('\n')[0]!) : null
    return tool ? (
      <Box flexDirection="row" columnGap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {el}
        </Box>
        <Box flexShrink={0}>{tool}</Box>
      </Box>
    ) : (
      el
    )
  }
  const marked = (words: string) => opts.mark?.(words) ?? null
  // a report's callout (report.ts normalizeDoc writes it as a quote opening with its kind): the kind as a dim label,
  // red for a warning or a caution, its text after it on L (views/SPEC.md, section 7, "A report")
  const calloutRow = (kind: string, body: RenderElement) => (
    <Box flexDirection="row">
      <Box width={CALLOUT_W} flexShrink={0}>
        <Text {...(kind === 'warning' || kind === 'caution' ? { color: COLORS.problem } : { dimColor: true })}>{kind}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {body}
      </Box>
    </Box>
  )
  const under = (m: ReturnType<typeof marked>) => {
    if (m?.under.length) out.push(<Box marginLeft={M} flexDirection="column">{m.under}</Box>)
  }
  for (const block of blocks) {
    n++
    if (block.type === 'md') {
      if (!live) {
        push(<Markdown text={plainMarkdown(block.text)} />)
        continue
      }
      // The engine's Markdown, so its text selects, its links open, its bold and headings are drawn bold and its code
      // is coloured as in any reply; a heading and the prose right under it (no blank line between) as two pieces, each
      // with its own "?"
      const pieces = (opts.items ? askPieces(block.text) : mdPieces(block.text).map(p => ({ text: p, join: false }))).flatMap(p => {
        const lines = p.text.split('\n')
        return /^#{1,6}\s/.test(lines[0]!) && lines.length > 1 && lines.slice(1).join('\n').trim() ? [{ text: lines[0]!, join: p.join }, { text: lines.slice(1).join('\n'), join: true }] : [p]
      })
      pieces.forEach(({ text: piece, join }, j) => {
        const isHead = /^#{1,6}\s/.test(piece)
        if (isHead) heading = piece.split('\n')[0]!
        const m = marked(piece)
        const ask: Ask = { key: `${prefix}md-${n}-${j}`, askKey: `ask-md:${prefix}${n}-${j}`, press: about(piece), passage: passageOf(piece), ...(m ? { bar: m.color } : {}) }
        const co = CALLOUT_MD.exec(piece)
        const el = co ? calloutRow(co[1]!.toLowerCase(), <Markdown text={plainMarkdown(co[2]!.replace(/^>\s?/gm, ''))} />) : tooled(<Markdown text={plainMarkdown(piece)} />, piece)
        // a list's items follow each other without a blank row, and a heading's text follows it without one
        const afterHead = j > 0 && /^#{1,6}\s/.test(pieces[j - 1]!.text)
        if (j === 0) push(el, ask)
        else out.push(join || afterHead ? row(el, ask) : <Box marginTop={1}>{row(el, ask)}</Box>)
        under(m)
      })
      continue
    }
    if (block.type === 'card') {
      order++
      cardReply.set(block.id, text)
      await $.state.get({ ...RUNS, id: block.id }) // a finished run redraws the card
      const f = await cardFile($, block.id)
      if (!f.data) {
        const fix = (await $.state.get({ ...FIXES, id: `card-${block.id}` })).value
        const more = fix?.state === 'fixing' ? ' · ◌ being fixed' : fix?.state === 'failed' ? ' · the fix failed' : ''
        push(<Text color={COLORS.problem} wrap="wrap">{`× card ${order} cannot be drawn: ${f.why}${more}`}</Text>)
        continue
      }
      const card = await labelled($, f.data)
      const meta = await metaOf($, card.id)
      const w = Math.min(cols, CARD_MAX_COLS)
      const m = marked(`[[card:${card.id}]]`)
      const at = where(heading)
      const ask: Ask = { key: `${prefix}cardbox-${n}`, askKey: `ask-card:${prefix}${n}`, press: () => void threadOn($, { kind: 'card', ref: `card:${card.id}`, cardId: card.id }, at, `card:${card.id}`), passage: `card:${card.id}`, top: 1, ...(m ? { bar: m.color } : {}) }
      if (live) {
        const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
        // the card draws its own frame (card.tsx); the "?" beside its title row, under the border: a side thread about
        // the card, as a press on its title
        push(<Client key={`${prefix}card-${n}-${card.id}`} module="./card.tsx" width={w} props={{ card, cols: w, debug, meta }} />, ask)
      } else push(framedCard($, e, card, w), ask)
      under(m)
      // a figure's caption: dim, right under the card's border
      if (block.caption) out.push(row(<Text dimColor wrap="wrap">{block.caption}</Text>))
      continue
    }
    const chips: ChipView[] = []
    const ids: string[] = []
    const raws: string[] = []
    const cls = blockClaims(block, answer)
    rememberClaims(cls)
    for (const cl of cls) {
      chips.push(await chipView($, cl))
      ids.push(cl.key)
      raws.push(cl.c.raw)
    }
    // its words with each citation as written, for the thread; a heading's "?" asks about its section
    const words = `${block.heading ? `${'#'.repeat(block.heading)} ` : ''}${richMarkdown({ ...block, heading: 0 }, c => c.raw)}`
    if (live) {
      // the mod's own drawing: each citation a chip (red with a problem, a spinner while worked on, lit under the
      // pointer), a click on it the panel; a drag selects and copies (para.tsx). It fills the column.
      const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
      const first = block.runs[0]
      const co = block.quote && first && !first.cite ? CALLOUT_RUN.exec(first.text) : null
      const para = co ? (
        calloutRow(co[1]!.toLowerCase(), <Client key={`${prefix}para-${n}`} module="./para.tsx" width={cols - CALLOUT_W} props={{ cols: cols - CALLOUT_W, block: { ...block, quote: false, runs: [{ ...first!, text: first!.text.slice(co[0].length) }, ...block.runs.slice(1)] }, chips, ids, raws }} />)
      ) : (
        <Client key={`${prefix}para-${n}`} module="./para.tsx" width={cols} props={{ cols, block, chips, ids, raws }} />
      )
      if (block.heading) heading = words
      const m = block.heading ? null : marked(words)
      push(tooled(para, words), { key: `${prefix}parabox-${n}`, askKey: `ask-para:${prefix}${n}`, press: about(words), passage: passageOf(words), ...(m ? { bar: m.color } : {}) })
      under(m)
      continue
    }
    // elsewhere, Markdown with each citation a link to its file
    const md = richMarkdown(block, (c, k) => {
      const v = chips[k]
      // Markdown has no red: a problem not yet worked on is marked × too
      const mark = v?.spin ? ' ◌' : v?.mark ? ` ${v.mark}` : v?.state === 'problem' ? ' ×' : ''
      return `${streamLink(c, placeUrl(c.ref))}${mark}`
    })
    push(<Markdown text={plainMarkdown(md)} />)
  }
  return out
}

// a callout's label column: its longest kind ("important") and a gutter
const CALLOUT_W = 'important'.length + 2
const CALLOUT_MD = /^>\s?(note|tip|important|warning|caution) {2}([\s\S]*)$/i
const CALLOUT_RUN = /^(note|tip|important|warning|caution) {2}/i

/** A card the mod draws itself (off the terminal, the citation panel): a full round border in the rule grey with a
 *  cell of padding (views/SPEC.md, rule 11), its title on the first row inside, a blank row, then its label row and
 *  its body; `lines` in place of the card's own layout (a cited mark lit). */
function framedCard($: Dollar, e: ResolveInput, card: CardData, w: number, lines?: Line[], key?: string): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const inner = Math.max(10, w - 4)
  return (
    <Box {...(key ? { key } : {})} flexDirection="column" width={w} borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
      {paintLines(Box, Text, [[{ s: cut(card.question, inner) }], [], ...labelHead(card, inner).lines, ...(lines ?? cardLayout(card, inner, -1).lines)])}
    </Box>
  )
}

// ------------------------------------------------------------------------------------------------ the cited item on a card

const sameKey = (a: string, b: string) => a === b || (a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b)) || a.toLowerCase() === b.toLowerCase()

/** The item of a card's layout a verdict names (by the resolver's column and row), -1 for none. */
function citedItem(card: CardData, items: Item[], v: ChatVerdict): number {
  if (v.kind !== 'value' || v.column == null || v.row == null) return -1
  if (card.kind === 'diagram' && v.column === 'edge') {
    const nodes = (card.nodes ?? []).slice(0, MAX_NODES)
    const ids = new Set(nodes.map(n => n.id))
    const e = card.edges?.[Number(v.row) - 1]
    const kept = (card.edges ?? []).slice(0, MAX_EDGES).filter(x => ids.has(x.source) && ids.has(x.target) && x.source !== x.target)
    const j = e ? kept.indexOf(e) : -1
    return j < 0 ? -1 : nodes.length + j
  }
  if (card.kind === 'diagram' && v.column === 'node') return (card.nodes ?? []).slice(0, MAX_NODES).findIndex(n => String(n.id) === v.row)
  if (card.kind === 'timeline') {
    const n = Number(v.row) - 1
    return n >= 0 && n < items.length ? n : -1
  }
  const pre = `card:${card.id}#${v.column}/`
  return items.findIndex(it => it.open.startsWith(pre) && sameKey(it.open.slice(pre.length), v.row!))
}

/** A card whose cited table or bar row is past the rows drawn, that row in place of the last one drawn. */
function withCitedRow(card: CardData, v: ChatVerdict): CardData {
  const cap = card.kind === 'table' ? MAX_TABLE_ROWS : card.kind === 'bar' || card.kind === 'label' ? MAX_BARS : 0
  const all = card.rows ?? []
  if (!cap || all.length <= cap || v.row == null) return card
  const r = all.findIndex(x => sameKey(fmt(card.kind === 'table' ? (x as Cell[])[0] : (x as BarRow).label), v.row!))
  return r < cap ? card : { ...card, rows: [...all.slice(0, cap - 1), all[r]!] as CardData['rows'] }
}

/** The cells of a layout that hit item k, shaded. */
function litItem(lay: Layout, k: number, bg: string): Line[] {
  if (k < 0) return lay.lines
  const spans: { line: number; x0: number; x1: number }[] = []
  lay.lines.forEach((l, y) => {
    const w = lineWidth(l)
    let x0 = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && lay.hit(x, y) === k
      if (on && x0 < 0) x0 = x
      if (!on && x0 >= 0) {
        spans.push({ line: y, x0, x1: x })
        x0 = -1
      }
    }
  })
  return shade(lay.lines, spans, bg)
}

// ------------------------------------------------------------------------------------------------ panes

// the terminal's width, as last measured: by a command, by the row above the prompt while no pane of the mod's is
// seated, or by the panel's own drawing (measurePanel)
let termColumns = 0
// the terminal width the docked panel was last opened or fitted at
let fittedFor = 0
let clicking = 0 // a Client's gesture is being handled: what it opens is no person's asking
const paneTurns = turns() // the panel's drawings, one at a time

/** The columns the panel asks for: 96, or what leaves main 70 beside it. */
function panelColumns(): number {
  return termColumns ? Math.max(36, Math.min(PANEL_COLS, termColumns - MAIN_KEEP - 1)) : PANEL_COLS
}

/** Measure the terminal from the panel's drawing, which every change of width redraws: docked, it is main's columns,
 *  the panel's body and the rule between them; inline (under 110), main's. A resize keeps the dock at the width it
 *  was opened with, so after one the panel opens again at panelColumns() (a width the person dragged still wins). */
function measurePanel($: Dollar, e: PaneEvent): void {
  const place = e.props.placement
  if (e.surface !== 'terminal' || !e.viewport?.columns || (place !== 'dock' && place !== 'inline')) return
  termColumns = place === 'dock' ? e.viewport.columns + e.props.bodyColumns + 1 : e.viewport.columns
  if (place !== 'dock' || termColumns === fittedFor || termColumns < 110) return
  fittedFor = termColumns
  if (panelColumns() === e.props.bodyColumns) return
  // opened once the drawing is done
  $.clock.after(0, () => {
    void (async () => {
      const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANEL && p.isPlaced)
      if (!pane) return
      const columns = panelColumns()
      const r = await $.ui.open({ id: PANEL, title: pane.title, columns }).catch((err: unknown) => ({ isPlaced: false, reason: String(err) }))
      await logEvent($, { event: 'pane', result: `refitted to ${columns} at ${termColumns} columns: ${r.isPlaced ? 'placed' : `waits: ${String((r as { reason?: unknown }).reason)}`}` })
    })()
  })
}

/** Open a pane with the keys. With a draft in the prompt the keys stay there (Claude Code keeps the person's typing),
 *  so the analyst is told to click the pane, which then takes them. */
async function openPane($: Dollar, view: PanelView, title: string): Promise<void> {
  const unasked = clicking > 0
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'panelView' }, view)
  // the breadcrumb and back (hooks/nav.ts) take the step
  await navStep($, view, title)
  const args = { id: PANEL, title, focus: true as const, columns: panelColumns() }
  fittedFor = termColumns
  // a click below 144 columns does not seat the panel, whatever floor the engine keeps for it: the band offers it
  if (unasked && termColumns && termColumns < CLICK_FLOOR && !(await $.ui.panes().catch(() => [])).some(p => p.id === PANEL && p.isPlaced)) {
    await logEvent($, { event: 'pane', view, result: `held: a click at ${termColumns} columns` })
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'pending' }, args)
    return
  }
  let r: Awaited<ReturnType<Dollar['ui']['open']>>
  try {
    r = await $.ui.open(args)
  } catch (err) {
    await logEvent($, { event: 'pane', view, result: `failed: ${clip(String(err), 200)}` })
    $.ui.log(`thimble-cc-mod: could not open the ${title} panel: ${clip(String(err), 200)}`)
    return
  }
  await logEvent($, { event: 'pane', view, columns: String(args.columns), result: r.isPlaced ? 'placed' : `waits: ${r.reason}` })
  // Opened from a Client's click below its floor, the panel waits undrawn: the band offers it as a button, whose press
  // is the person's own, so it opens at any width.
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'pending' }, r.isPlaced ? null : args)
  if (!r.isPlaced) return
  if (view === 'home') watchHome($)
  try {
    if ((await $.prompt.read()).text.trim()) $.ui.toast('the prompt holds a draft, so it keeps the keys: click the panel to use its keys')
  } catch {
    // no prompt to read
  }
}

/** Close the panel, or drop the one the band offers. Its way stays: what opens next leads back to what it showed. */
async function closePanel($: Dollar): Promise<void> {
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'pending' }, null)
  await $.ui.close({ id: PANEL })
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'panelView' }, '')
}

/** Open the citation panel on a claim (`key`), or on a citation of its own (a mark's, a record's, with the passage the
 *  example quotes). */
async function openCitation($: Dollar, c: Citation, key?: string, quote?: string): Promise<void> {
  const id = cid(c.raw)
  remember([c])
  if (quote) quotes.set(id, quote)
  else quotes.delete(id)
  if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'open' }, key && claimMap.has(key) ? key : id)
  await openPane($, 'cite', 'Citation')
}

/** The place a citation cites, in the panel. */
async function openPlace($: Dollar, c: Citation, key?: string, quote?: string): Promise<void> {
  await openCitation($, c, key, quote)
}

async function openCardPane($: Dollar, id: string, mode: string): Promise<void> {
  const card = await loadCard($, id)
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneCard' }, id)
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneMode' }, mode)
  await openPane($, 'card', clip(card?.question ?? 'Card', 60))
}

/** Where position `p` of a line lands once each tab is drawn as two spaces. */
function tabbed(text: string, p: number): number {
  return p + (text.slice(0, p).match(/\t/g)?.length ?? 0)
}

/** A cited line wrapped in at most `rows` rows around its highlight (the shown value, or the passage the example
 *  quotes) on the selection background, its number right-aligned at A2 in the text colour on its first row. */
function wrappedRows(els: { Text: (p: object) => RenderElement }, w: { n: number; text: string; spans?: number[][] }, quote: string, gutter: number, cols: number, rows: number): RenderElement[] {
  const { Text } = els
  const room = Math.max(10, cols - gutter - 4)
  const text = w.text.replace(/\t/g, '  ')
  const first = w.spans?.[0]
  const span: [number, number] | null = quote ? quoteSpan(text, quote) : first ? [tabbed(w.text, first[0]!), tabbed(w.text, first[1]!)] : null
  return wrapAround(text, span, room, rows).map((r, i) =>
    Text({
      // a row that ends in "…" is a cell wider than the room: cut, not wrapped under the gutter
      wrap: 'truncate-end',
      children: [
        Text({ children: `  ${i === 0 ? String(w.n).padStart(gutter) : ' '.repeat(gutter)}  ` }),
        Text({ children: r.hi ? r.text.slice(0, r.hi[0]) : r.text || ' ' }),
        ...(r.hi ? [Text({ backgroundColor: COLORS.selected, children: r.text.slice(r.hi[0], r.hi[1]) }), Text({ children: r.text.slice(r.hi[1]) })] : []),
      ],
    }),
  )
}

/** A line around the cited ones: its number right-aligned at A2, dim (in the text colour on a cited line), its text
 *  after a gutter, the cited value on the selection background. */
function lineRow(els: { Text: (p: object) => RenderElement }, w: { n: number; text: string; hit: boolean; spans?: number[][] }, gutter: number, cols: number): RenderElement {
  const { Text } = els
  const room = Math.max(10, cols - gutter - 4)
  let text = w.text.replace(/\t/g, '  ')
  let spans = (w.spans ?? []).map(([a, b]) => [tabbed(w.text, a!), tabbed(w.text, b!)])
  if (text.length > room) {
    const lo = spans.length ? Math.max(0, spans[0]![0]! - Math.floor(room / 3)) : 0
    text = (lo ? '…' : '') + text.slice(lo, lo + room - 2) + '…'
    spans = spans.map(([a, b]) => [a! - lo + (lo ? 1 : 0), b! - lo + (lo ? 1 : 0)])
  }
  const parts: RenderElement[] = []
  let at = 0
  for (const [a, b] of spans.filter(([a, b]) => a! >= 0 && b! <= text.length).sort((x, y) => x[0]! - y[0]!)) {
    if (a! < at) continue
    parts.push(Text({ children: text.slice(at, a) }))
    parts.push(Text({ backgroundColor: COLORS.selected, children: text.slice(a, b) }))
    at = b!
  }
  parts.push(Text({ children: text.slice(at) || ' ' }))
  // a cited line is told by its number in the text colour; its text stands on the panel, only the cited value lit
  return Text({
    wrap: 'truncate-end',
    children: [Text({ ...(w.hit ? {} : { dimColor: true }), children: `  ${String(w.n).padStart(gutter)}  ` }), Text({ children: parts })],
  })
}

/** What a side thread about a citation (a claim's key, or a citation's id) is told: the sentence, the ref and what the
 *  place shows. */
async function citationContext($: Dollar, key: string): Promise<{ label: string; context: string; ref: string }> {
  const c = citeOf(key)
  const v = c ? (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value : undefined
  const sentence = claimMap.get(key)?.sentence ?? ''
  const shows = v?.window?.filter(w => w.hit).map(w => w.text).join('\n') ?? v?.value ?? ''
  return {
    ref: c?.raw ?? '',
    label: c ? `the citation ${c.raw}` : 'a citation',
    context: [sentence && `The sentence: "${clip(sentence, 600)}"`, v && `Checked: ${STATUS_WORDS[v.status] ?? v.status} (${v.why}).`, shows && `The cited place shows: ${clip(shows, 1500)}`]
      .filter(Boolean)
      .join('\n'),
  }
}

/** What a side thread about a card is told: its question, script, data in brief and the takeaway. */
async function cardContext($: Dollar, id: string): Promise<{ label: string; context: string; ref: string }> {
  const card = await loadCard($, id)
  const takeaway = takeawayAfter(cardReply.get(id) ?? '', id)
  const data = card ? clip(JSON.stringify(card.rows ?? card.series ?? card.events ?? card.examples ?? (card.nodes ? { nodes: card.nodes, edges: card.edges } : [])), 1500) : ''
  return {
    ref: `[[card:${id}]]`,
    label: card ? `the card "${card.question}"` : 'a card',
    context: [
      card?.source?.script && `Made by ${card.source.script}${card.params?.length ? ` with ${card.params.map(p => `${p.name} = ${p.value}`).join(', ')}` : ''}.`,
      data && `Its data (${HOME}/cards/${id}.json): ${data}`,
      takeaway && `Its takeaway in the reply: ${takeaway}`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

// ------------------------------------------------------------------------------------------------ gestures

const DEBUG_FLAG = `${HOME}/debug`
const OFF = /^(|0|off|false|no)$/i

/** The mouse log is on when .thimble-cc-mod/debug says so (/thimble-cc-mod debug on|off writes it), else when
 *  THIMBLE_CC_MOD_DEBUG is set. */
async function loadDebug($: Dollar): Promise<void> {
  await paths($)
  let flag: string | undefined
  try {
    flag = (await $.fs.read(`${cwd}/${DEBUG_FLAG}`)).trim()
  } catch {
    flag = undefined
  }
  const env = flag === undefined ? ((await $.env.get('THIMBLE_CC_MOD_DEBUG').catch(() => undefined)) ?? '').trim() : ''
  debug = !OFF.test(flag ?? env)
}

let logFailed = false

/** Append a line to .thimble-cc-mod/mouse.log; the first failure is said once in the transcript. */
async function writeMouseLog($: Dollar, line: string): Promise<void> {
  await paths($)
  mouseLog.push(line)
  try {
    await $.fs.write(`${cwd}/${HOME}/mouse.log`, `${mouseLog.slice(-500).join('\n')}\n`)
  } catch (err) {
    if (!logFailed) $.ui.log(`thimble-cc-mod: could not write ${HOME}/mouse.log: ${String(err).slice(0, 160)}`)
    logFailed = true
  }
}

/** One line of the mouse log: a press or release a Client saw, and what it made. */
async function logMouse($: Dollar, module: string, g: Sent): Promise<void> {
  const ev: Partial<PointerEv> = g.ev ?? {}
  const mods = (['shift', 'ctrl', 'alt'] as const).filter(k => ev[k]).join('+') || 'none'
  const at = new Date(await $.clock.now()).toISOString()
  await writeMouseLog($, JSON.stringify({ at, event: ev.type, button: ev.button, mods, gesture: g.gesture ?? 'none', target: g.target ? `${g.target.kind}: ${targetLabel(g.target)}` : '', module }))
}

/** A line of the mouse log for what the mod did next: the action a gesture ran, the pane it opened (placed, waiting,
 *  failed), a subagent it stopped. */
async function logEvent($: Dollar, fields: Record<string, string>): Promise<void> {
  if (!debug) return
  await writeMouseLog($, JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...fields }))
}

/** A gesture of a Client: a click (and a right-click, which does what a click does) opens the place a target cites (a
 *  citation, a record); on anything else of a card (a point of a plot, a bar, a row, a node, the card itself) a side
 *  thread about it: "what was going on here?" */
async function onGesture($: Dollar, g: Gesture, t: Target, ev?: PointerEv): Promise<void> {
  void ev
  if (g !== 'primary') return
  const c = placeOf(t)
  if (c) await openPlace($, c, t.claim, await quoteOf($, t))
  else if (cardOf(t)) await act($, 'thread', t)
}

/** The passage an example card quotes from the record a target names. */
async function quoteOf($: Dollar, t: Target): Promise<string | undefined> {
  if (t.kind !== 'record' || !t.cardId) return undefined
  const card = await loadCard($, t.cardId)
  return card?.examples?.find(x => x.ref === t.ref)?.quote || undefined
}

/** What a side thread about a target is told. */
async function aboutTarget($: Dollar, t: Target): Promise<{ label: string; context: string; ref?: string }> {
  const card = cardOf(t)
  const c = citationOf(t)
  if (t.kind === 'card' && card) return cardContext($, card)
  if (t.kind === 'citation' && c) {
    remember([c])
    return citationContext($, t.claim && claimMap.has(t.claim) ? t.claim : cid(c.raw))
  }
  if (t.kind === 'sentence' || !c) {
    const s = (t.text ?? '').trim()
    return { label: `the passage "${clip(plainCites(s), 48)}"`, context: s ? `The passage of the reply: "${clip(s, 1500)}"` : '' }
  }
  const base = card ? await cardContext($, card) : null
  return {
    ref: c.raw,
    label: `${targetLabel(t)}${base ? ` on ${base.label}` : ''}`,
    context: [`The analyst points at ${c.raw}.`, base?.context].filter(Boolean).join('\n'),
  }
}

/** A side thread about a target, told where it stands (a report's passage: the report and its section), and kept by
 *  the passage it was asked about, whose margin then shows its "↳". */
async function threadOn($: Dollar, t: Target, where: string, passage?: string): Promise<void> {
  const about = await aboutTarget($, t)
  await openThread($, { ...about, context: [where, about.context].filter(Boolean).join('\n'), ...(passage ? { passage } : {}) })
}

/** One action on a target, from a gesture or a panel's control. */
async function act($: Dollar, what: Act, t: Target): Promise<void> {
  await logEvent($, { event: 'act', act: what, target: `${t.kind}: ${targetLabel(t)}` })
  const card = cardOf(t)
  switch (what) {
    case 'open': {
      const c = placeOf(t)
      if (c) await openPlace($, c, t.claim, await quoteOf($, t))
      return
    }
    case 'thread': {
      const about = await aboutTarget($, t)
      await openThread($, about)
      return
    }
    case 'verify': {
      const c = citationOf(t)
      if (!c || c.display === null) return
      const id = cid(c.raw)
      remember([c])
      if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
      // a reply's citation is verified as the claim of its sentence in its answer, never as another answer's
      const key = t.claim && claimMap.has(t.claim) ? t.claim : id
      // the citation panel shows the verification as it runs: its script, output and outcome
      await openPlace($, c, key, await quoteOf($, t))
      await askVerify($, key)
      return
    }
    case 'script':
      if (card) await openCardPane($, card, 'script')
      return
    case 'rerun':
      if (card) void rerunCard($, card)
      return
    case 'files': {
      const c = placeOf(t)
      if (c) await openRef($, c.ref)
      return
    }
  }
}

// ------------------------------------------------------------------------------------------------ while a reply streams

const asWritten = new Map<string, string>() // a text block as the engine was handed it while it streamed -> as written

/** The file a citation's place is in, as a file: URL, the target of its link while the reply streams. */
function placeUrl(ref: string): string {
  const [base = ''] = ref.split('#', 1)
  const m = /^(card|call):([A-Za-z0-9_-]+)$/.exec(base)
  const file = m ? `${cwd}/${HOME}/${m[1]}s/${m[2]}.json` : base.startsWith('/') ? base : `${cwd}/${base}`
  return `file://${encodeURI(file).replace(/[()]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`
}

/** How a streaming reply shows citations and card lines; the cards' questions are read before (`questions`). */
function streamLook(questions: Map<string, string>): StreamLook {
  return {
    link: c => streamLink(c, placeUrl(c.ref)),
    card: id => {
      const q = questions.get(id)
      // the card's question while the card is drawn, ◌ before it: running
      return `◌ ${q ? q.replace(/[\\[\]*_`<>]/g, m => `\\${m}`) : 'drawing the card'}`
    },
  }
}

/** The text rows of a turn in main, split at each tool call: the last part holds the answer. */
type Part = { rows: ChatRow[] }

/** The part of a turn that is its answer: the last one that cites or embeds a card, else the last one. Earlier parts
 *  are what main wrote while it worked ("Reading the files…"). */
function answerPart(parts: Part[]): Part | undefined {
  const full = parts.filter(p => p.rows.some(r => r.text.trim()))
  return [...full].reverse().find(p => needsDrawing(p.rows.map(r => r.text).join('\n\n'))) ?? full.at(-1)
}

// ------------------------------------------------------------------------------------------------ register

type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>

// ------------------------------------------------------------------------------------------------ the panel's way
//
// The breadcrumb at the panel's top, back, and the threads tree (rules in hooks/nav.ts). Every view opens through
// openPane, which hands the step to navStep.

// Where the latest gesture, press or command came from: inside the panel or not. What the panel opens soon after a
// press inside it extends the breadcrumb, and a thread asked then hangs under the thread on it; anything else starts
// the breadcrumb over.
let navFrom: { panel: boolean; at: number } | null = null
// the way a press on back, a crumb, a child thread or the tree chose, which the panel's next opening takes as it is
let navTo: ChatNav | null = null
const NAV_FRESH = 5000

async function navOrigin($: Dollar, panel: boolean): Promise<void> {
  navFrom = { panel, at: await $.clock.now().catch(() => 0) }
}

/** Whether what opens now was asked from inside the panel. */
async function navInPanel($: Dollar): Promise<boolean> {
  return !!navFrom?.panel && (await $.clock.now().catch(() => 0)) - navFrom.at < NAV_FRESH
}

/** The step the panel opens: its view, and what names it there. */
async function snapStep($: Dollar, view: PanelView, title: string): Promise<ChatNavStep> {
  if (view === 'thread') return { view, title, thread: (await read($, threadA)) ?? '' }
  if (view === 'cite') return { view, title, open: (await read($, openA)) ?? '' }
  if (view === 'card') return { view, title, card: (await read($, paneCardA)) ?? '', mode: (await read($, paneModeA)) ?? '' }
  if (view === 'view') return { view, title, slug: (await read($, viewOpenA)) ?? '' }
  if (view === 'report') return { view, title, slug: (await read($, reportNavA))?.slug ?? '' }
  if (view === 'label') return { view, title, slug: (await $.state.get({ plugin: 'thimble-cc-mod', key: 'label' })).value ?? '' }
  return { view, title }
}

/** A thread saved by this or an earlier session, read from its file and not put in state (a drawing writes none). */
async function savedThread($: Dollar, id: string): Promise<ChatThread | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  await paths($)
  return parseThread(await $.fs.read(`${cwd}/${HOME}/threads/${id}.json`).catch(() => '')) ?? undefined
}

/** A thread of this session, or one saved by an earlier session put back into this session's state. */
async function threadOrSaved($: Dollar, id: string): Promise<ChatThread | undefined> {
  const known = await getThread($, id)
  if (known || !/^[A-Za-z0-9_-]+$/.test(id)) return known
  await paths($)
  const t = parseThread(await $.fs.read(`${cwd}/${HOME}/threads/${id}.json`).catch(() => ''))
  if (!t) return undefined
  await setThread($, t)
  const list = (await read($, threadListA)) ?? []
  if (!list.includes(t.id)) await $.state.set({ plugin: 'thimble-cc-mod', key: 'threadList' }, [...list, t.id].slice(-20))
  return t
}

/** A thread's steps under the threads it was asked from, the root first. */
async function threadSteps($: Dollar, id: string): Promise<ChatNavStep[]> {
  const out: ChatNavStep[] = []
  const seen = new Set<string>()
  for (let at = id; at && !seen.has(at) && out.length < 12; ) {
    seen.add(at)
    const t = await threadOrSaved($, at)
    if (!t) break
    out.unshift({ view: 'thread', title: 'Threads', thread: at })
    at = t.parent ?? ''
  }
  return out
}

/** The panel opened `view`: its way moves, and a thread it shows has its answers read. */
async function navStep($: Dollar, view: PanelView, title: string): Promise<void> {
  const step = await snapStep($, view, title)
  let next = navTo
  navTo = null
  if (!next) {
    const cur = (await read($, navA)) ?? NAV_EMPTY
    const chain = step.view === 'thread' && step.thread ? await threadSteps($, step.thread) : [step]
    next = moved(cur, nextTrail(cur.trail, step, await navInPanel($), chain))
  }
  navFrom = null
  await $.state.set(NAV, next)
  // a report opened is no longer new
  if (step.view === 'report' && step.slug) freshReports.delete(step.slug)
  const t = step.thread ? await getThread($, step.thread) : undefined
  if (t) await setSeen($, t.id, answered(t))
}

/** Show the last step of `nav.trail`, with `nav` as the panel's way. */
async function navGo($: Dollar, nav: ChatNav): Promise<void> {
  const s = nav.trail.at(-1)
  if (!s) return
  if (s.view === 'thread') await $.state.set({ plugin: 'thimble-cc-mod', key: 'thread' }, s.thread ?? '')
  else if (s.view === 'cite') await $.state.set({ plugin: 'thimble-cc-mod', key: 'open' }, s.open ?? '')
  else if (s.view === 'card') {
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneCard' }, s.card ?? '')
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneMode' }, s.mode ?? '')
  } else if (s.view === 'view') await $.state.set({ plugin: 'thimble-cc-mod', key: 'view' }, s.slug ?? '')
  else if (s.view === 'report' && s.slug && (await read($, reportNavA))?.slug !== s.slug) await $.state.set({ plugin: 'thimble-cc-mod', key: 'reportNav' }, { slug: s.slug, slide: 0, notes: false, open: [] })
  else if (s.view === 'label' && s.slug) await $.state.set({ plugin: 'thimble-cc-mod', key: 'label' }, s.slug)
  navTo = nav
  await openPane($, s.view as PanelView, s.title)
}

async function navBack($: Dollar): Promise<void> {
  const to = backTarget((await read($, navA)) ?? NAV_EMPTY)
  if (to) await navGo($, to)
}

/** Whether the analyst sees the thread now: the panel is drawn and shows it. */
async function showsThread($: Dollar, id: string): Promise<boolean> {
  return (await read($, viewA)) === 'thread' && (await read($, threadA)) === id && !(await read($, pendingA))
}

/** A thread's turn ended (threadComplete): its answer is read when the panel shows the thread; otherwise main's chat
 *  gets a row under its latest row, and the count above the prompt goes up (hooks/signal.ts). */
async function seenIfShown($: Dollar, t: ChatThread): Promise<void> {
  if (await showsThread($, t.id)) return setSeen($, t.id, answered(t))
  const turn = t.turns.length
  if (!signalEnd(t, turn)) return
  const at = signals.last || WAITING
  const rows = withSignal((await $.state.get({ ...THREAD_ROWS, id: at })).value ?? signals.rows[at] ?? [], { thread: t.id, turn })
  await $.state.set({ ...THREAD_ROWS, id: at }, rows)
  signals.rows[at] = rows
  await saveSignals($)
  await refreshNews($)
}

async function unreadOf($: Dollar, t: ChatThread): Promise<number> {
  return unread(t, (await $.state.get({ ...THREAD_SEEN, id: t.id })).value)
}

/** The answers of a thread the analyst has seen, in state and in signals.json. */
async function setSeen($: Dollar, id: string, n: number): Promise<void> {
  await $.state.set({ ...THREAD_SEEN, id }, n)
  if (signals.seen[id] === n) return
  signals.seen[id] = n
  await saveSignals($)
  await refreshNews($)
}

/** How many threads, this session's and earlier ones, hold answers unread: the count above the prompt. */
async function refreshNews($: Dollar): Promise<void> {
  const threads = await allThreads($)
  const seen = new Map<string, number | undefined>()
  for (const t of threads) seen.set(t.id, (await $.state.get({ ...THREAD_SEEN, id: t.id })).value)
  const news = newsOf(threads, id => seen.get(id))
  const cur = (await read($, newsA)) ?? NEWS
  if (cur.n !== news.n || cur.one !== news.one) await $.state.set({ plugin: 'thimble-cc-mod', key: 'threadNews' }, news)
}

/** A row of main's chat a signal can stand under was stored (signal.ts isAnchor): the latest one, which takes the
 *  rows that waited for one. */
async function anchorAt($: Dollar, row: string): Promise<void> {
  if (!row || signals.last === row) return
  signals.last = row
  const waiting = signals.rows[WAITING]
  if (waiting?.length) {
    await $.state.set({ ...THREAD_ROWS, id: row }, waiting)
    await $.state.set({ ...THREAD_ROWS, id: WAITING }, [])
    signals.rows[row] = waiting
    delete signals.rows[WAITING]
  }
  const views = signals.views[WAITING]
  if (views?.length) {
    await $.state.set({ ...VIEW_ROWS, id: row }, views)
    await $.state.set({ ...VIEW_ROWS, id: WAITING }, [])
    signals.views[row] = views
    delete signals.views[WAITING]
  }
  await saveSignals($)
}

async function saveSignals($: Dollar): Promise<void> {
  await paths($)
  signals.session = await $.session.id().catch(() => signals.session)
  const text = signalsJson(signals)
  signalsSaved = signalsSaved.then(() => $.fs.write(`${cwd}/${SIGNALS}`, text)).catch(() => undefined)
  await signalsSaved
}

/** signals.json as earlier sessions in this folder left it, put in state where it holds none: each thread's answers
 *  seen, so the unread marks hold after a resume, and the rows by the row each stands under (a resumed transcript
 *  keeps its rows' ids); the latest row to stand under only from this session (a resume, or a reload of the hooks). */
async function loadSignals($: Dollar): Promise<void> {
  await paths($)
  const got = parseSignals(await $.fs.read(`${cwd}/${SIGNALS}`).catch(() => ''))
  const session = await $.session.id().catch(() => '')
  for (const [id, n] of Object.entries(got.seen)) {
    const live = (await $.state.get({ ...THREAD_SEEN, id })).value
    if (live === undefined) await $.state.set({ ...THREAD_SEEN, id }, n)
    else got.seen[id] = live
  }
  for (const [id, rows] of Object.entries(got.rows)) {
    if (id === WAITING && got.session !== session) continue
    const live = (await $.state.get({ ...THREAD_ROWS, id })).value
    if (live?.length) got.rows[id] = live
    else await $.state.set({ ...THREAD_ROWS, id }, rows)
  }
  for (const [id, slugs] of Object.entries(got.views)) {
    if (id === WAITING && got.session !== session) continue
    const live = (await $.state.get({ ...VIEW_ROWS, id })).value
    if (live?.length) got.views[id] = live
    else await $.state.set({ ...VIEW_ROWS, id }, slugs)
  }
  if (got.session !== session) {
    delete got.rows[WAITING]
    delete got.views[WAITING]
    got.last = ''
  }
  for (const slug of got.fresh ?? []) freshViews.add(slug)
  signals = { ...got, seen: { ...got.seen, ...signals.seen }, rows: { ...got.rows, ...signals.rows }, views: { ...got.views, ...signals.views }, fresh: [...freshViews], last: signals.last || got.last }
  await refreshNews($)
}

type RowEvent =
  | MatchedEvent<'ui.render', { component: 'AssistantMessage' }>
  | MatchedEvent<'ui.render', { component: 'UserMessage' }>
  | MatchedEvent<'ui.render', { component: 'TurnDuration' }>
  | MatchedEvent<'ui.render', { component: 'CommandOutput' }>

/** The rows a row of main's chat carries under it (views/SPEC.md, "Main's chat", a `↳` row): each side thread's turn
 *  that ended there while the panel did not show the thread (`↳ thread · "question" · answered`), and each view main
 *  proposed in the answer it ends (`↳ view · Wiki Pages · built`); `↳` at column 0 and the words at 2, dim, a press
 *  opening the thread or the view; `new` in green while the answer waits unread or the view was not yet opened,
 *  `failed` in red; a proposed view's row ends with `build`. Null when it carries none. */
async function signalRows($: Dollar, e: RowEvent): Promise<RenderElement | null> {
  const list = (await $.state.get({ ...THREAD_ROWS, id: e.requestId })).value ?? []
  const views = (await $.state.get({ ...VIEW_ROWS, id: e.requestId })).value ?? []
  if (!list.length && !views.length) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const cols = Math.max(30, (e.viewport?.columns ?? 100) - 2)
  const out: RenderElement[] = []
  const gap = () => (out.length ? {} : { marginTop: 1 })
  for (const [i, s] of list.entries()) {
    const t = (await getThread($, s.thread)) ?? (await savedThread($, s.thread))
    const end = t ? signalEnd(t, s.turn) : null
    if (!t || !end) continue
    const fresh = end === 'answered' && !signalRead(t, s.turn, (await $.state.get({ ...THREAD_SEEN, id: t.id })).value)
    const tail = ` · ${end}`
    out.push(
      <Box key={`signal-row:${e.requestId}:${i}`} flexDirection="row" {...gap()}>
        <Text dimColor>{'↳ '}</Text>
        <Button key={`signal:${e.requestId}:${i}`} label={`thread · ${signalQuestion(t, s.turn, Math.max(16, Math.min(60, cols - tail.length - 12)))}`} plain dimColor onPress={() => void showThread($, t)} />
        <Text {...(end === 'failed' ? { color: COLORS.problem } : { dimColor: true })}>{tail}</Text>
        {fresh ? <Text dimColor>{' · '}</Text> : null}
        {fresh ? <Text color={FRESH}>new</Text> : null}
      </Box>,
    )
  }
  await read($, proposalsA) // drawn again when a view's state changes
  for (const slug of views) {
    const r = pipes.get(slug)
    if (!r) continue
    const w = stateWords(r.s, r.drawable)
    const fresh = freshViews.has(slug) && w.state === 'built'
    const open = async () => {
      if (r.drawable && (w.state === 'built' || w.state === 'stopped')) return openView($, slug)
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'viewPane' }, slug)
      await openPane($, 'views', 'Views')
    }
    out.push(
      <Box key={`view-row:${e.requestId}:${slug}`} flexDirection="row" {...gap()}>
        <Text dimColor>{'↳ '}</Text>
        <Button key={`view-signal:${e.requestId}:${slug}`} label={`view · ${clip(r.p.name, 48)}`} plain dimColor onPress={() => void open()} />
        <Text {...(w.state === 'failed' ? { color: COLORS.problem } : { dimColor: true })}>{` · ${w.state === 'failed' ? 'failed' : w.state}`}</Text>
        {fresh ? <Text dimColor>{' · '}</Text> : null}
        {fresh ? <Text color={FRESH}>new</Text> : null}
        {w.state === 'proposed' && !working.has(slug) ? <Text>{'  '}</Text> : null}
        {w.state === 'proposed' && !working.has(slug) ? <Button key={`view-build:${e.requestId}:${slug}`} label="build" plain onPress={() => void startBuild($, slug)} /> : null}
      </Box>,
    )
  }
  return out.length ? <Box key={`signals:${e.requestId}`} flexDirection="column">{out}</Box> : null
}

/** What a step's crumb says (a lower-case kind word and its name, or the name alone after the list it is in), and its
 *  mark: ◌ while its thread answers, `new` while answers wait unread. */
async function crumbOf($: Dollar, s: ChatNavStep): Promise<{ text: string; mark: string }> {
  switch (s.view) {
    case 'thread': {
      const t = await getThread($, s.thread ?? '')
      if (!t) return { text: 'thread', mark: '' }
      return { text: threadTitle(t), mark: t.turns.at(-1)?.state === 'running' ? '◌' : (await unreadOf($, t)) ? 'new' : '' }
    }
    case 'cite': {
      const id = s.open ?? ''
      const record = viewRecords.get(id)
      if (record !== undefined) return { text: `record "${record}"`, mark: '' }
      const v = (await $.state.get({ ...VERDICTS, id })).value
      const c = citeOf(id) ?? (v ? { raw: v.raw, ref: v.ref, display: v.display } : undefined)
      return { text: c ? `citation ${citeTitle(c)}` : 'citation', mark: '' }
    }
    case 'card': {
      const card = s.card ? await loadCard($, s.card) : null
      return { text: `card "${card?.question ?? s.title}"${s.mode === 'script' ? ' · script' : ''}`, mark: '' }
    }
    case 'view': {
      const spec = loaded.get(s.slug ?? '')?.view.spec
      if (s.slug === FILES_TREE) return { text: 'files', mark: '' }
      return { text: spec?.name ?? s.title, mark: '' }
    }
    case 'label':
      return { text: s.title.replace(/^label:?\s*/i, ''), mark: '' }
    case 'report':
      return { text: `"${s.title}"`, mark: '' }
    default:
      return { text: s.view === 'coverage' ? 'coverage' : s.view, mark: '' }
  }
}

/** The list a step stands in, which the path shows before it unless the step before it is that list: `threads` before
 *  a thread, `labels` before a label, `views` before a view the pipeline built, `files` before a file, `reports` before
 *  a report. */
function upOf(s: ChatNavStep, earlier: readonly ChatNavStep[], spec: ViewSpec | null | undefined): { text: string; view: PanelView; files?: true } | null {
  const before = earlier.at(-1)
  // `threads` once, before the first thread of the path
  if (s.view === 'thread') return earlier.some(x => x.view === 'thread' || x.view === 'threads') ? null : { text: 'threads', view: 'threads' }
  if (s.view === 'label') return before?.view === 'labels' ? null : { text: 'labels', view: 'labels' }
  if (s.view === 'report') return before?.view === 'reports' ? null : { text: 'reports', view: 'reports' }
  if (s.view === 'view' && s.slug !== FILES_TREE) {
    if (spec?.up || (s.slug ?? '').startsWith('@')) return before?.view === 'view' && before.slug === FILES_TREE ? null : { text: 'files', view: 'view', files: true }
    return before?.view === 'views' ? null : { text: 'views', view: 'views' }
  }
  return null
}

/** Hotkeys with no label of their own (views/SPEC.md, "The visual system", rule 26: the key-hint row says them): plain
 *  Buttons in a Box no row tall, so the panel's keys still press them. */
function hiddenKeys($: Dollar, e: { surface: string } & object, keys: { key: string; hotkey: string; onPress: () => void }[]): RenderElement | null {
  if (!keys.length || e.surface === 'mobile') return null
  const { Box, Button } = $.ui.resolve(e as PaneEvent)
  return (
    <Box key="hidden-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {keys.map(k => (
        <Button key={k.key === 'close' ? 'close' : k.key.startsWith('=') ? k.key.slice(1) : `hk-${k.key}`} label={k.hotkey} hotkey={k.hotkey} plain onPress={k.onPress} />
      ))}
    </Box>
  )
}

/** The panel's path row (views/SPEC.md, "A panel's header"): `‹ back` (b), the path from home, each step a lower-case
 *  kind word and its name (or the name alone after its list) parted by a dim ›, each a click away, a step whose thread
 *  has new answers followed by `new` in green; at the right `show all threads`, which opens the threads panel, and
 *  `N new` in green while answers wait unread. The threads panel leaves it out. */
async function wayRow($: Dollar, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const nav = (await read($, navA)) ?? NAV_EMPTY
  const view = (await read($, viewA)) as PanelView
  const back = backTarget(nav)
  const ownB = view === 'views' || view === 'report'
  const inThreads = view === 'threads' || view === 'thread'
  // threads with answers unread, this session's and earlier ones
  const fresh = ((await read($, newsA)) ?? NEWS).n
  const tailW = inThreads ? 0 : 'show all threads'.length + (fresh ? `  ${fresh} new`.length : 0) + 2
  const backW = back ? 6 + 2 : 0
  // the first crumb is home, the home panel's own step when the trail starts from it; a step's list before it
  const { steps, skipped } = crumbSteps(nav.trail)
  type Crumb = { text: string; mark: string; go: () => void; here?: boolean; up?: boolean }
  const crumbs: Crumb[] = []
  for (const [i, s] of steps.entries()) {
    const up = upOf(s, steps.slice(0, i), s.view === 'view' ? loaded.get(s.slug ?? '')?.view.spec : undefined)
    if (up) crumbs.push({ text: up.text, mark: '', up: true, go: () => void (up.files ? openFiles($) : openPane($, up.view, up.text.replace(/^./, ch => ch.toUpperCase()))) })
    const c = await crumbOf($, s)
    crumbs.push({ ...c, go: () => void navGo($, { trail: nav.trail.slice(0, i + 1 + skipped), back: withBack(nav.back, nav.trail) }), here: i === steps.length - 1 })
  }
  // a bare list panel (threads, views, labels, reports, coverage) has its own step
  const marksW = crumbs.reduce((n, c) => n + (c.mark ? c.mark.length + 1 : 0), 0)
  const fitted = fitCrumbs(['home', ...crumbs.map(c => c.text)], Math.max(12, cols - backW - tailW - marksW))
  const parts: RenderElement[] = []
  fitted.forEach((text, i) => {
    if (text === null) {
      if (fitted[i - 1] !== null) parts.push(<Text dimColor>{' › …'}</Text>)
      return
    }
    if (i) parts.push(<Text dimColor>{' › '}</Text>)
    const c = i ? crumbs[i - 1]! : null
    if (c?.mark === '◌') parts.push(<Text>{'◌ '}</Text>)
    if (c?.here) parts.push(<Text>{text}</Text>)
    else if (c) parts.push(<Button key={c.up ? 'crumb-up' : `crumb-${i}`} label={text} plain onPress={c.go} />)
    else if (view === 'home' && fitted.length === 1) parts.push(<Text>{text}</Text>)
    else parts.push(<Button key="crumb-home" label={text} plain onPress={() => void openHome($)} />)
    if (c?.mark === 'new') parts.push(<Text color={FRESH}>{' new'}</Text>)
  })
  return (
    <Box key="way" flexDirection="row">
      {back ? <Button key="nav-back" label="‹ back" plain onPress={() => void navBack($)} /> : null}
      {back ? <Text>{'  '}</Text> : null}
      {parts}
      <Box flexGrow={1} />
      {inThreads ? null : <Button key="threads" label="show all threads" plain onPress={() => void openPane($, 'threads', 'Threads')} />}
      {!inThreads && fresh ? <Text color={FRESH}>{`  ${fresh} new`}</Text> : null}
      {hiddenKeys($, e, [...(back && !ownB ? [{ key: 'back', hotkey: 'b', onPress: () => void navBack($) }] : []), ...(inThreads ? [] : [{ key: 'threads', hotkey: 't', onPress: () => void openPane($, 'threads', 'Threads') }])])}
    </Box>
  )
}

/** A view of the panel under its path row, on the panel's grid (views/SPEC.md, "The visual system", section 2): a
 *  cell of padding at each side, then the 2-cell margin M, then the type area from A0 to R. A row that brings its own
 *  margin (a key starting `m:`: a `❯`, a passage's `?` or `↳`, a Client drawn from lines) stands as it is; every other
 *  row gets an empty margin. `e` is the event as inset() narrowed it to the type area. */
async function withWay($: Dollar, e: PaneEvent, body: RenderElement): Promise<RenderElement> {
  const way = await wayRow($, e)
  const { Box } = $.ui.resolve(e)
  const kids = (body.type === 'Box' && body.props?.flexDirection === 'column' ? (body.children ?? []) : [body]).filter(k => Boolean(k)) as RenderElement[]
  const rows = [way, ...kids].map(k => (hasMargin(k) ? k : <Box paddingLeft={MARGIN_W} flexDirection="column">{k}</Box>))
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {rows}
    </Box>
  )
}

/** The pane's event with its body narrowed to the type area: a cell of padding at each side and the 2-cell margin. */
function inset(e: PaneEvent): PaneEvent {
  return { ...e, props: { ...e.props, bodyColumns: Math.max(20, e.props.bodyColumns - 2 - MARGIN_W) } } as PaneEvent
}

/** The pane's event with `n` body rows fewer: a view laid out to the rows it has, under the panel's top row. */
function lessRows(e: PaneEvent, n: number): PaneEvent {
  const sc = e.props.scroll
  return sc ? ({ ...e, props: { ...e.props, scroll: { ...sc, bodyRows: Math.max(1, sc.bodyRows - n) } } } as PaneEvent) : e
}

// ------------------------------------------------------------------------------------------------ panels drawn from lines

/** A region of a panel drawn from lines (homeview.tsx) and what a click on it does. */
type LineHit = { y: number; x0: number; x1: number; row: boolean; run: () => Promise<void> | void }
// what each drawing's hits and keys do, by its stamp: the same drawing keeps its stamp, so a Client is not drawn again
// for nothing; the oldest are let go
const lineStamps = new Map<string, { runs: (() => Promise<void> | void)[]; key?: (k: string) => Promise<void> | void }>()
const lineSeen = new Map<string, number>() // the last click or key handled, by the Client instance that sent it

function stampOf(key: string, lines: readonly Line[], hits: readonly LineHit[]): string {
  let h = 0x811c9dc5
  const str = `${key}\u0000${JSON.stringify(lines)}\u0000${hits.map(x => `${x.y},${x.x0},${x.x1},${x.row ? 1 : 0}`).join(';')}`
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193)
  return `${key}:${(h >>> 0).toString(36)}`
}

/** A panel's part drawn from styled lines by the Client homeview.tsx, `cols` wide: its hits (a row, a link, a control)
 *  run their closures on a click (left or right), its keys go to `onKey` once a click gave it the keyboard. Its key
 *  starts with `m:` when its lines bring the margin (withWay). */
function linesEl($: Dollar, e: PaneEvent, key: string, lines: Line[], hits: LineHit[], cols: number, onKey?: (k: string) => Promise<void> | void): RenderElement {
  if (e.surface !== 'terminal' && e.surface !== 'desktop') {
    const { Text } = $.ui.resolve(e)
    return <Text>{lines.map(l => l.map(x => x.s).join('')).join('\n')}</Text>
  }
  const { Client } = $.ui.resolve(e as unknown as ResolveInput<'Pane', 'terminal'>)
  const stamp = stampOf(key, lines, hits)
  lineStamps.delete(stamp)
  lineStamps.set(stamp, { runs: hits.map(h => h.run), ...(onKey ? { key: onKey } : {}) })
  for (const k of [...lineStamps.keys()].slice(0, Math.max(0, lineStamps.size - 600))) lineStamps.delete(k)
  const packed = hits.flatMap((h, i) => [h.y, h.x0, h.x1, h.row ? 1 : 0, i])
  return <Client key={key} module="./homeview.tsx" width={cols} height={Math.max(1, lines.length)} props={JSON.parse(JSON.stringify({ lines: lines.map(mergeSegs), hits: packed, stamp, cols, ...(onKey ? { keys: true } : {}) })) as never} />
}

/** A post of homeview.tsx: each click and key not seen yet, by the drawing it was made in. */
async function linesMessage($: Dollar, origin: unknown, raw: unknown): Promise<void> {
  if (!Array.isArray(raw) || typeof origin !== 'string') return
  for (const a of raw as { seq?: unknown; i?: unknown; k?: unknown; s?: unknown }[]) {
    if (typeof a?.seq !== 'number' || a.seq <= (lineSeen.get(origin) ?? 0)) continue
    lineSeen.set(origin, a.seq)
    const got = lineStamps.get(String(a.s))
    if (!got) continue
    if (typeof a.k === 'string') await got.key?.(a.k)
    else await got.runs[Number(a.i)]?.()
  }
}

/** In a citation opened from a side thread, a field whose question goes on in that thread, about the citation; the
 *  panel then shows the thread. */
async function followUpField($: Dollar, e: PaneEvent, about: string): Promise<RenderElement | null> {
  if (e.surface === 'mobile') return null
  const tid = threadBehind(((await read($, navA)) ?? NAV_EMPTY).trail)
  const t = tid ? await getThread($, tid) : undefined
  if (!t) return null
  const { Box, Text, Input } = $.ui.resolve(e)
  const g = await ensureGuide($)
  // its label dim and lower case with no colon, as every label (views/SPEC.md, rule 6), the field after a gutter
  return (
    <Box key="follow-row" flexDirection="row">
      <Text dimColor>{'follow-up  '}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Input key={`follow-${askKey(t.id)}`} submitLabel="ask" onSubmit={v => void askFollowUp($, t.id, v, about, g)} />
      </Box>
    </Box>
  )
}

async function askFollowUp($: Dollar, tid: string, q: string, about: string, g: string): Promise<void> {
  if (!q.trim()) return
  await askThread($, tid, `${q.trim()} (about ${about})`, g)
  const nav = (await read($, navA)) ?? NAV_EMPTY
  let i = nav.trail.length - 1
  while (i >= 0 && nav.trail[i]!.thread !== tid) i--
  if (i >= 0) await navGo($, { trail: nav.trail.slice(0, i + 1), back: withBack(nav.back, nav.trail) })
}

// ------------------------------------------------------------------------------------------------ the panel's views

/** Code as Claude Code colours it (its `Code` element): a script, a label's code, a command; given `startLine`, its
 *  dim gutter of line numbers (views/SPEC.md, "The visual system", rule 14). At most `max` lines, then `… N more`. */
function codeRows($: Dollar, e: PaneEvent, source: string, max = 400, language = 'python', startLine: number | null = 1): RenderElement {
  const { Box, Text, Code } = $.ui.resolve(e)
  const lines = source.replace(/\t/g, '    ').split('\n')
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const shown = lines.slice(0, lines.length > max + 1 ? max : lines.length)
  return (
    <Box flexDirection="column">
      <Code source={shown.join('\n') || ' '} language={language} {...(startLine !== null ? { startLine } : {})} wrap="truncate-end" />
      {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} more`}</Text> : null}
    </Box>
  )
}

/** A script's name as the analyst reads it: its file name, or "the script" for one named by a hash or a stamp. */
function scriptName(path: string | undefined): string {
  const base = (path ?? '').split('/').at(-1) ?? ''
  return !base || /^v-[a-z0-9]+\.py$/.test(base) || /^[0-9a-f]{6,}\.py$/.test(base) || /\d{8}[-_]?\d{6}/.test(base) ? 'the script' : base
}

/** Label/value rows (rule 27): each label dim, lower case, in a column as wide as the longest label + 2, its value
 *  after it. */
function fieldRows($: Dollar, e: PaneEvent, rows: [string, RenderElement | string, string?][]): RenderElement | null {
  return fieldEls($.ui.resolve(e), rows)
}

/** The panel's bottom part (rule 25): the second rule, the actions at A0 2 cells apart, the fields under them; then the
 *  key-hint row, the panel's last. */
function bottomRows($: Dollar, e: PaneEvent, cols: number, controls: (RenderElement | null | false)[], fields: (RenderElement | null | false)[], hints: string[], rule = true): RenderElement[] {
  const els = $.ui.resolve(e)
  const ctl = controlsEl(els, controls, 'bottom-controls')
  const fs = fields.filter((f): f is RenderElement => Boolean(f))
  return [...(rule && (ctl || fs.length) ? [ruleEl(els, cols, 'rule-bottom')] : []), ...(ctl ? [ctl] : []), ...fs, hintsEl(els, hints, cols)]
}

/** The cited value with the value underlined and blue in its sentence (the `source` row). */
function sourceSegs(sentence: string, c: Citation): Line {
  const flat = plainCites(sentence).replace(/\s+/g, ' ')
  const shown = c.display ?? ''
  const at = shown ? flat.indexOf(shown) : -1
  if (at < 0) return [{ s: `"${flat}"` }]
  return [{ s: `"${flat.slice(0, at)}` }, linkSeg(shown), { s: `${flat.slice(at + shown.length)}"` }]
}

/** The citation panel (views/SPEC.md, section 7, "The citation panel"): the title is the cited value, bold, blue and
 *  underlined (a link to its place; red when the value is not there), ✓ after it once a script got it; the subtitle
 *  its status in plain words; under the rule, `from`, `command` (a command's output, coloured as shell) and `source`
 *  (the reply's sentence, the value in it underlined); the cited lines nested at A2, their numbers in a dim column and
 *  the value on the selection background, or the cited card in its frame with the cited mark lit; a verification's
 *  verdict and its script; at the bottom, after the second rule, `verify  ask about it` and the follow-up field. */
async function drawCite($: Dollar, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const els = { Box, Text, Button }
  // `id` keys the claim's fix and verification (a citation's own id for a mark or a record); the verdict is the
  // citation's, whatever sentence holds it
  const id = await read($, openA)
  const own = id ? (await $.state.get({ ...VERDICTS, id })).value : undefined
  // after a reload the module's maps are empty; the verdict in state still holds a citation opened by its own id
  const c = id ? (citeOf(id) ?? (own ? { raw: own.raw, ref: own.ref, display: own.display } : undefined)) : undefined
  const cols = Math.max(30, e.props.bodyColumns)
  if (!c) return <Box flexDirection="column"><Text dimColor>none</Text></Box>
  const v = own ?? (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
  const run = (await $.state.get({ ...VERIFY, id })).value
  const fix = (await $.state.get({ ...FIXES, id })).value
  const status = v?.status ?? 'pending'
  const look = chipLook(status, fix?.state, run?.state)
  // the passage an example quotes, or the words a citation quotes
  const quote = quotes.get(cid(c.raw)) ?? quotedWords(c.display)
  const body: RenderElement[] = []
  // a record a view opened is named by its row, as the view showed it
  const record = c.display === null ? viewRecords.get(id) : undefined
  const label = record ? clip(record, Math.max(20, cols - 4)) : citeTitle(c)
  const problem = status === 'missing' || status === 'differs'
  const red = problem || run?.state === 'refuted' || verifyFailed(run?.state)
  const said = `${statusWords(c, v, status, run)}${problem && v?.why ? ` · ${plainWhy(v.why)}` : ''}`
  const canVerify = c.display !== null
  const busy = run?.state === 'asked' || run?.state === 'running'
  const ask = async () => openThread($, await citationContext($, id))
  // the title: the value as a link to its place (its file in the file browser, a card in the card pane)
  const mark = look.mark === '✓' ? ' ✓' : look.mark ? ` ${look.mark}` : look.spin ? ' ◌' : ''
  const titleSegs: Line = [{ s: cut(label, Math.max(8, cols - 4)), b: true, ...(red ? { fg: COLORS.problem, u: true } : { fg: LINK, u: true }) }, ...(mark ? [{ s: mark, ...(look.mark && look.mark !== '✓' ? { fg: COLORS.problem } : {}) }] : [])]
  const cardId = CARD_OF.exec(c.ref)?.[1]
  const opens = fileRef(c.ref) ? () => openRef($, c.ref) : cardId ? () => openCardPane($, cardId, '') : null
  body.push(opens ? linesEl($, e, 'cite-title', [titleSegs], [{ y: 0, x0: 0, x1: textWidth(cut(label, Math.max(8, cols - 4))), row: false, run: () => void opens() }], cols) : lineEl(els, titleSegs, 'cite-title'))
  body.push(lineEl(els, [{ s: said, ...(red ? { fg: COLORS.problem } : { fg: COLORS.dim }) }], 'cite-sub', true))
  body.push(ruleEl(els, cols, 'cite-rule'))
  // where it is from, the command that printed it, the sentence it stands in, what the card shows now, a fix round
  const sentence = claimMap.get(id)?.sentence
  const rows: [string, RenderElement | string, string?][] = [['from', placeName(c.ref)]]
  if (v?.kind === 'call' && v.command) {
    const cmd = v.command.split('\n').slice(0, 4).join('\n')
    // the shell's `$` before it, dim, as the sketch has it (views/SPEC.md, section 7, "The citation panel")
    rows.push([
      'command',
      <Box flexDirection="row">
        <Text dimColor>{'$ '}</Text>
        <Box flexGrow={1} flexShrink={1}>{codeRows($, e, cmd, 4, 'bash', null)}</Box>
      </Box>,
    ])
  }
  if (sentence) rows.push(['source', lineEl(els, sourceSegs(sentence, c), 'cite-source', true)])
  const choice = await otherChoice($, c.ref)
  if (choice) rows.push(['note', choice])
  if (fixNote(status, fix)) rows.push(['fix', fixNote(status, fix), COLORS.problem])
  body.push(fieldRows($, e, rows)!)
  if (!v) body.push(<Text dimColor>◌ checking</Text>)
  else if (v.kind === 'value' || v.kind === 'card') {
    const card = v.card ? await loadCard($, v.card) : null
    if (card) {
      // the cited item on the selection background (a table's cell, a bar, a line's point, a timeline's event, a
      // node), kept in view: a table's column names, then the rows around it; the card in its frame
      const w = Math.min(cols, 96)
      const inner = Math.max(10, w - 4)
      const shown = v.kind === 'value' ? withCitedRow(card, v) : card
      const k = citedItem(shown, cardLayout(shown, inner, -1, 8).items, v)
      const lay = cardLayout(shown, inner, k, 8)
      const lit = shown.kind === 'table' || shown.kind === 'bar' || shown.kind === 'label'
      let rows2 = lit ? litItem(cardLayout(shown, inner, -1, 8), k, COLORS.selected) : lay.lines
      if (k < 0 && (shown.kind === 'bar' || shown.kind === 'label') && v.kind === 'value' && v.row === 'all') {
        rows2 = rows2.map(l => {
          const at = l.findIndex(x => x.s === 'all  ')
          return at < 0 ? l : l.map((x, j) => (j === at + 1 ? { ...x, bg: COLORS.selected } : x))
        })
      }
      const room = Math.max(8, (e.props.scroll?.bodyRows || 20) - 14)
      const ys = rows2.flatMap((l, y) => (l.some(x => x.bg === COLORS.selected || x.inv) ? [y] : []))
      if (rows2.length > room && ys.length && ys.at(-1)! >= room) {
        // a table's column names are the lines before its first row
        let head = 0
        if (shown.kind === 'table') while (head < rows2.length && lay.hit(0, head) < 0) head++
        const lo = Math.max(head, Math.min(ys[0]! - 1, rows2.length - (room - head)))
        rows2 = [...rows2.slice(0, head), ...rows2.slice(lo, lo + room - head)]
      }
      body.push(framedCard($, e, shown, w, rows2, 'cite-card'))
    }
  } else if (v.window.length) {
    const gutter = Math.max(...v.window.map(w => String(w.n).length))
    // the cited lines wrapped, the value or the quoted passage lit; when they take many rows, less context around
    const hits = v.window.filter(w => w.hit)
    const hitRows = Math.max(3, Math.min(8, Math.floor(((e.props.scroll?.bodyRows || 20) - 14) / Math.max(1, hits.length))))
    const wraps = hits.some(w => w.text.length > cols - gutter - 4)
    const near = wraps ? 2 : 99
    const firstHit = v.window.findIndex(w => w.hit)
    const lastHit = v.window.length - 1 - [...v.window].reverse().findIndex(w => w.hit)
    const lines = v.window.filter((w, i) => w.hit || (i >= firstHit - near && i <= lastHit + near))
    body.push(<Box key="cite-lines" flexDirection="column">{lines.flatMap(w => (w.hit ? wrappedRows({ Text } as never, w, quote, gutter, cols, hitRows) : [lineRow({ Text } as never, w, gutter, cols)]))}</Box>)
    if (quote && status !== 'differs' && !hits.some(w => quoteSpan(w.text, quote))) body.push(fieldRows($, e, [['quoted', <Text wrap="wrap" backgroundColor={COLORS.selected}>{clip(quote, 600)}</Text>]])!)
  }
  // the verification: its verdict at A0, its script nested at A2
  if (run) {
    const words: Record<string, string> = {
      asked: `◌ a subagent is writing a script that recomputes ${clip(citeLabel(c), 60)}`,
      running: '◌ running the script',
      missing: `× not written: ${run.stderr ? `the subagent ended without writing the script: ${clip(run.stderr, 200)}` : 'there is no script'}`,
      verified: `✓ the script ${placeRun(run) ? 'found' : 'got'} ${resultWords(run.result)}, as cited`,
      refuted: `× the script ${placeRun(run) ? 'found' : 'got'} ${resultWords(run.result)}; the reply cites ${resultWords(citedAs(run.expected, run.ref ?? c.ref))}`,
      error: `× ${verifyError(run)}`,
      // a citation without a value, judged by a subagent that read its place (a report's "verify this section")
      ...(run.kind === 'support'
        ? { asked: '◌ a subagent is reading the cited place', verified: `✓ it supports the sentence: ${run.why ?? ''}`, refuted: `× it does not support the sentence: ${run.why ?? ''}`, missing: `× not judged: ${clip(run.stderr ?? '', 200)}` }
        : {}),
    }
    const tone = verifyFailed(run.state) ? { color: COLORS.problem } : busy ? { dimColor: true } : {}
    body.push(<Text key="cite-verdict" {...tone} wrap="wrap">{words[run.state] ?? run.state}</Text>)
    if (run.source) body.push(<Box key="cite-script" marginLeft={2} flexDirection="column">{codeRows($, e, run.source.slice(0, 6000), 400)}</Box>)
    // what a failed script printed, dim, nested under it
    if (verifyFailed(run.state) && (run.stdout || run.stderr)) {
      const tail = `${run.stdout ?? ''}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-8)
      body.push(<Box key="cite-out" marginLeft={2} flexDirection="column">{tail.map(l => <Text dimColor wrap="truncate-end">{l || ' '}</Text>)}</Box>)
    }
  } else if (!canVerify && record === undefined) body.push(<Text dimColor wrap="wrap">This citation shows no value to recompute.</Text>)
  // the bottom: what can be done with it, where its result appears; a question about it goes on in its thread
  const verify = () => void askVerify($, id)
  const controls = [
    canVerify && !run ? <Button key="verify" label="verify" plain onPress={verify} /> : null,
    run && !busy && run.kind !== 'support' ? <Button key="rerun" label="run again" plain onPress={() => void runVerify($, id)} /> : null,
    run && (run.state === 'missing' || run.state === 'error') ? <Button key="again" label="verify again" plain onPress={verify} /> : null,
    <Button key="ask" label="ask about it" plain onPress={() => void ask()} />,
  ]
  const goOn = await followUpField($, e, c.raw)
  const keys = [
    ...(canVerify && !run ? [{ key: 'verify', hotkey: 'v', onPress: verify }] : []),
    ...(run && !busy && run.kind !== 'support' ? [{ key: 'rerun', hotkey: 'r', onPress: () => void runVerify($, id) }] : []),
    ...(run && (run.state === 'missing' || run.state === 'error') ? [{ key: 'again', hotkey: 'v', onPress: verify }] : []),
    { key: 'ask', hotkey: 'a', onPress: () => void ask() },
    ...(fileRef(c.ref) ? [{ key: 'files', hotkey: 'f', onPress: () => void openRef($, c.ref) }] : []),
    { key: 'close', hotkey: 'x', onPress: () => void closePanel($) },
  ]
  const hints = [canVerify && !run ? 'v to verify' : run && !busy && run.kind !== 'support' ? 'r to run again' : '', 'a to ask', fileRef(c.ref) ? 'f for its file' : '', 'b to go back', 'x to close'].filter(Boolean)
  body.push(...bottomRows($, e, cols, controls, [goOn], hints))
  const hk = hiddenKeys($, e, keys)
  if (hk) body.unshift(hk)
  return <Box flexDirection="column">{body}</Box>
}

/** The key of a side thread's question field: its own for each thread, stable across reloads (a hash of the thread's
 *  id, so the drawing carries no id). */
function askKey(thread: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < thread.length; i++) h = Math.imul(h ^ thread.charCodeAt(i), 0x01000193) >>> 0
  return `ask-${h.toString(36)}`
}

/** Where a thread was asked, the root its tree hangs it under: a report, else main. */
function threadRoot(t: ChatThread): string {
  const m = /In the report "([^"]+)"/.exec(t.context)
  return m ? `report "${clip(m[1]!, 50)}"` : 'main'
}

/** The first line of a thread's latest answer, or what it is doing. */
function threadLine(t: ChatThread): { s: string; fg?: string } {
  const last = t.turns.at(-1)
  if (!last) return { s: 'nothing asked yet', fg: COLORS.dim }
  if (last.state === 'running') return { s: `◌ answering · ${last.tools} tool call${last.tools === 1 ? '' : 's'}`, fg: COLORS.dim }
  if (last.state === 'error') return /^\s*stopped/.test(last.a) ? { s: 'stopped', fg: COLORS.dim } : { s: `× ${plainCites(last.a).split('\n')[0] ?? ''}`, fg: COLORS.problem }
  const done = [...t.turns].reverse().find(x => x.state === 'done')
  const first = plainCites(threadBody(withoutTaskLine(done?.a ?? ''))).replace(/^#+\s*/gm, '').split('\n').find(l => l.trim()) ?? ''
  return { s: first.replace(/\*\*|__|`/g, '').trim(), fg: COLORS.dim }
}

/** The threads panel (views/SPEC.md, section 7, "The threads panel"): its title and a dim subtitle (`2 threads · 1
 *  new`); under the rule, the tree: where threads were asked (`main`, a report) at A0, each thread under it with
 *  guides, a thread asked from a thread a level deeper, its question in quotation marks and the first line of its
 *  latest answer dim under it, `N questions` dim and `new` in green at R; the selected thread (`❯`, accent) shows
 *  under the second rule, its questions and answers drawn as main's chat draws a reply, then the `ask` field. */
async function drawThreads($: Dollar, e: PaneEvent, selected = ''): Promise<RenderElement> {
  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Threads need a surface with text fields.</Text>
  }
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const els = { Box, Text, Button }
  const cols = Math.max(30, e.props.bodyColumns)
  const threads = await allThreads($)
  const seen = new Map<string, number | undefined>()
  for (const t of threads) seen.set(t.id, (await $.state.get({ ...THREAD_SEEN, id: t.id })).value)
  const fresh = threads.filter(t => unread(t, seen.get(t.id)) > 0).length
  const body: RenderElement[] = [
    ...headerEls(els, { title: 'Threads', cols, sub: subLine([`${threads.length} thread${threads.length === 1 ? '' : 's'}`, fresh ? freshSeg(fresh) : null]) }),
  ]
  const t = selected ? await getThread($, selected) : undefined
  // the tree: a root per place threads were asked, its threads under it, the newest activity first
  const tree = threadTree(threads)
  const roots = [...new Set(tree.filter(r => r.depth === 0).map(r => threadRoot(r.t)))]
  const lines: Line[] = []
  const hits: LineHit[] = []
  const order: ChatThread[] = []
  const cap = t ? 12 : 50
  let shown = 0
  for (const root of roots) {
    if (lines.length) lines.push([])
    lines.push(pointed([{ s: root }], false))
    const under = tree.filter((r, i) => {
      // a root's rows: its top threads and every thread under them
      let k = i
      while (k > 0 && tree[k]!.depth > 0) k--
      return threadRoot(tree[k]!.t) === root
    })
    // guides of 2 cells a level, from the tree's own (3 cells a level)
    under.forEach(r => {
      if (shown >= cap) return
      shown++
      const n = unread(r.t, seen.get(r.t.id))
      const asked = r.t.turns.length
      const guide = r.guide.replace(/(.)../g, (_m, ch: string) => `${ch} `)
      const lead = r.under.replace(/(.)../g, (_m, ch: string) => `${ch} `)
      const right: Line = [...(asked > 1 ? [{ s: `${asked} questions`, fg: COLORS.dim }] : []), ...(n ? [...(asked > 1 ? [{ s: '  ' }] : []), freshSeg()] : [])]
      const name = spread([{ s: guide, fg: COLORS.rule }, { s: threadTitle(r.t) }], right, cols)
      const y = lines.length
      lines.push(pointed(name, r.t.id === selected))
      const second = threadLine(r.t)
      lines.push(pointed([{ s: lead.slice(0, guide.length), fg: COLORS.rule }, { s: cut(second.s, Math.max(10, cols - guide.length)), ...(second.fg ? { fg: second.fg } : {}) }], false))
      hits.push({ y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => showThread($, r.t) }, { y: y + 1, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => showThread($, r.t) })
      order.push(r.t)
    })
  }
  if (!threads.length) lines.push(pointed([{ s: '  ' }, { s: 'none', fg: COLORS.dim }], false))
  if (tree.length > shown) {
    const more = `… ${tree.length - shown} more`
    hits.push({ y: lines.length, x0: MARGIN_W + 2, x1: MARGIN_W + 2 + more.length, row: false, run: () => openPane($, 'threads', 'Threads') })
    lines.push(pointed([{ s: '  ' }, { s: more, fg: COLORS.dim }], false))
  }
  const step = async (d: number) => {
    if (!order.length) return
    const at = order.findIndex(x => x.id === selected)
    const next = order[Math.max(0, Math.min(order.length - 1, at < 0 ? (d > 0 ? 0 : order.length - 1) : at + d))]!
    await showThread($, next)
  }
  const focusAsk = async () => {
    if (t) await $.ui.focus({ requestId: PANEL, key: askKey(t.id) }).catch(() => undefined)
  }
  body.push(linesEl($, e, marginKey('threads-tree'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : k === 'return' || k === 'enter' ? focusAsk() : undefined)))
  // each thread a press away by its key too, for a surface that draws no Client: no row of its own; not while a thread
  // is shown, whose drawing carries no thread's id
  if (!t)
    body.unshift(
      <Box key="thread-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
        {order.map(x => <Button key={`thread-open:${x.id}`} label={threadTitle(x)} plain onPress={() => void showThread($, x)} />)}
      </Box>,
    )
  const g = await ensureGuide($)
  const keys: { key: string; hotkey: string; onPress: () => void }[] = [...order.slice(0, 9).map((x, i) => ({ key: `t${i}`, hotkey: String(i + 1), onPress: () => void showThread($, x) }))]
  if (t) {
    // the selected thread, under the second rule: each turn the analyst's question in quotation marks, its answer drawn
    // as main's chat draws a reply, then the field that asks the next question
    body.push(ruleEl(els, cols, 'rule-thread'))
    const running = t.turns.at(-1)?.state === 'running'
    let k = 0
    // what it is about, and what that passage opens with, until its first question
    if (!t.turns.length) {
      body.push(<Text wrap="wrap">{`about ${plainCites(t.label)}`}</Text>)
      const opens = aboutLine(t.label, t.context)
      if (opens) body.push(<Text dimColor wrap="truncate-end">{opens}</Text>)
    }
    for (const turn of t.turns) {
      k++
      if (k > 1) body.push(<Text> </Text>)
      body.push(<Text wrap="wrap">{`"${plainCites(turn.q)}"`}</Text>)
      if (turn.state === 'running') {
        const partial = withoutTaskLine(turn.partial).trim()
        body.push(<Text dimColor wrap="truncate-end">{`◌ answering · ${turn.tools} tool call${turn.tools === 1 ? '' : 's'}${partial ? ` · ${clip(partial, cols - 30)}` : ''}`}</Text>)
      } else if (turn.state === 'error') {
        body.push(<Text color={COLORS.problem} wrap="wrap">{`× ${turn.a}`}</Text>)
      } else {
        // the answer on the panel's grid: its marks at M, its text at A0
        body.push(<Box key={marginKey(`thread-answer-${k}`)} flexDirection="column">{await drawReply($, e, threadBody(withoutTaskLine(turn.a)), cols, `${t.id}:${k}`, `t${k}-`, false, { margin: PANEL_MARGIN })}</Box>)
      }
    }
    // an answer from a stand-in subagent was written without main's conversation, which the analyst should know
    if (t.engine && t.engine !== 'fork') body.push(<Text dimColor wrap="wrap">answered without the main conversation: the fork was refused</Text>)
    // Claude Code keeps a field's unsent text by its key, so each thread's field has its own: a draft stays with it
    const field = (
      <Box key="ask-row" flexDirection="row">
        <Text dimColor>{'ask  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Input key={askKey(t.id)} {...(t.turns.length === 0 ? { autoFocus: true as const } : {})} submitLabel="ask" onSubmit={v => void askThread($, t.id, v, g)} />
        </Box>
      </Box>
    )
    if (running) {
      body.push(controlsEl(els, [<Button key="stop" label="stop" plain onPress={() => void endThread($, t.id, 'stopped by the analyst')} />], 'thread-controls')!)
      keys.push({ key: 'stop', hotkey: 's', onPress: () => void endThread($, t.id, 'stopped by the analyst') })
    }
    body.push(field)
    keys.push({ key: 'ask', hotkey: 'a', onPress: () => void focusAsk() })
  }
  keys.push({ key: 'close', hotkey: 'x', onPress: () => void closePanel($) })
  body.push(hintsEl(els, ['↑↓ to choose', ...(t ? ['Enter or a to ask'] : []), ...(t && t.turns.at(-1)?.state === 'running' ? ['s to stop'] : []), 'b to go back', 'x to close'], cols))
  const hk = hiddenKeys($, e, keys)
  if (hk) body.unshift(hk)
  return <Box flexDirection="column">{body}</Box>
}

/** A card in the panel (views/SPEC.md, "Cards", the card pane): its question is the panel's title, its kind and the
 *  script that made it the dim subtitle; the card in its frame (card.tsx draws it, its readout row first); at the
 *  bottom `script  run again`. In script mode, the script through the `Code` element, its gutter at A0, its last run's
 *  output under it, and `card  run again` at the bottom. */
async function drawCard($: Dollar, e: PaneEvent): Promise<RenderElement> {
  const id = await read($, paneCardA)
  const mode = await read($, paneModeA)
  const card = id ? await loadCard($, id) : null
  if (e.surface !== 'terminal' && e.surface !== 'desktop') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>The interactive card needs the terminal or the desktop app.</Text>
  }
  const { Box, Text, Client, Button } = $.ui.resolve(e)
  const els = { Box, Text, Button }
  if (!card) return <Box flexDirection="column"><Text dimColor>none</Text></Box>
  const shownCard = await labelled($, card)
  const w = Math.max(30, Math.min(e.props.bodyColumns, CARD_MAX_COLS))
  const cols = Math.max(30, e.props.bodyColumns)
  const meta = await metaOf($, card.id)
  const run: ChatRun | undefined = (await $.state.get({ ...RUNS, id: card.id })).value
  const script = card.source?.script
  const rerun = <Button key="rerun" label={meta.busy ? '◌ running' : 'run again'} plain onPress={() => void rerunCard($, card.id)} />
  const body: RenderElement[] = []
  const keys = [{ key: 'rerun', hotkey: 'r', onPress: () => void rerunCard($, card.id) }, { key: 'close', hotkey: 'x', onPress: () => void closePanel($) }]
  const ran = run?.exitCode !== undefined ? { s: `last run exit ${run.exitCode}`, ...(run.exitCode ? { fg: COLORS.problem } : {}) } : null
  if (mode === 'script' && script) {
    await paths($)
    let source = ''
    try {
      source = await $.fs.read(`${cwd}/${script}`)
    } catch {
      source = `(cannot read ${script})`
    }
    body.push(...headerEls(els, { title: card.question, cols, sub: subLine([scriptName(script), ran]) }))
    body.push(codeRows($, e, source.slice(0, 9000), 400))
    if (run?.exitCode !== undefined) {
      const tail = `${scriptOutput(run.stdout ?? '')}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-8)
      body.push(<Text> </Text>)
      body.push(fieldRows($, e, [['output', tail.join('').trim() ? <Box flexDirection="column">{tail.map(l => <Text wrap="truncate-end">{l || ' '}</Text>)}</Box> : <Text dimColor>nothing printed</Text>]])!)
    }
    keys.push({ key: 'card', hotkey: 'c', onPress: () => void openCardPane($, card.id, '') })
    body.push(...bottomRows($, e, cols, [<Button key="card" label="card" plain onPress={() => void openCardPane($, card.id, '')} />, rerun], [], ['r to run again', 'c for the card', 'b to go back', 'x to close']))
  } else {
    body.push(...headerEls(els, { title: card.question, cols, sub: subLine([card.kind, script ? `made by ${scriptName(script)}` : 'no script recorded', ran]) }))
    body.push(<Client key={`pane-${id}`} module="./card.tsx" width={w} props={{ card: shownCard, cols: w, plotRows: 16, debug, meta, pane: true }} />)
    if (script) keys.push({ key: 'script', hotkey: 's', onPress: () => void openCardPane($, card.id, 'script') })
    body.push(...bottomRows($, e, cols, script ? [<Button key="script" label="script" plain onPress={() => void openCardPane($, card.id, 'script')} />, rerun] : [], [], [...(script ? ['s for the script', 'r to run again'] : []), 'b to go back', 'x to close']))
  }
  const hk = hiddenKeys($, e, keys)
  if (hk) body.unshift(hk)
  return <Box flexDirection="column">{body}</Box>
}

// ------------------------------------------------------------------------------------------------ reports


/** What the reports share of this module, bound to the hook's `$` (reports.tsx ReportCtx). */
function reportCtx($: Dollar): ReportCtx {
  return {
    home: HOME,
    panel: PANEL,
    margin: PANEL_MARGIN,
    now: () => $.clock.now(),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    mtime: async path => Number((await $.fs.stat(path)).mtimeMs ?? 0),
    list: async dir => (await $.fs.list(dir)).map(f => f.name),
    run: (argv, init) => $.process.run(argv, init),
    report: async slug => (await $.state.get({ ...REPORTS, id: slug })).value,
    setReport: async r => {
      // a report its writer just finished is new until the analyst opens it
      const was = (await $.state.get({ ...REPORTS, id: r.slug })).value
      if (was?.state === 'writing' && r.state === 'ready') freshReports.add(r.slug)
      await $.state.set({ ...REPORTS, id: r.slug }, r)
    },
    agent: async id => (await $.state.get({ ...AGENTS, id })).value,
    setAgent: async (id, a) => {
      await $.state.set({ ...AGENTS, id }, a)
    },
    nav: async () => (await read($, reportNavA)) ?? null,
    setNav: async nav => {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'reportNav' }, nav)
    },
    els: e => $.ui.resolve(e as ResolveInput<'Pane', 'terminal'>),
    scroll: async (key, block = 'start') => {
      await $.ui.scroll({ to: { key }, in: PANEL, block }).catch(() => undefined)
    },
    where: async () => {
      await paths($)
      return { cwd, root }
    },
    guide: () => ensureGuide($),
    drawReply: (e, text, width, answer, prefix, opts) => drawReply($, e, text, width, answer, prefix ?? '', false, opts ?? {}),
    cardEl: (e, id, width, key, focus, data) => reportCard($, e, id, width, key, focus, data),
    loadCard: id => loadCard($, id),
    openPane: (view, title) => openPane($, view, title),
    closePanel: () => closePanel($),
    spawn: (prompt, desc, fresh) => spawnSub($, prompt, desc, fresh),
    noteMain: text => noteMain($, text),
    link: (e, key, lines, hits, cols, onKey) => linesEl($, e as PaneEvent, key, lines, hits, cols, onKey),
    framed: (e, card, w, lines, key) => framedCard($, e, card, w, lines, key),
    code: (e, source, max, language, startLine) => codeRows($, e as PaneEvent, source, max, language, startLine ?? null),
    thread: async about => {
      await openThread($, about)
    },
    afterTurn: async fn => {
      if (mainBusy) afterMain.push(fn)
      else await fn()
    },
    // a report's "verify this section" (reports.tsx): its claims known, each verification's state, a script run, and
    // the evidence of a highlight opened as a citation's place
    remember: cls => rememberClaims(cls),
    verifyOf: async key => (await $.state.get({ ...VERIFY, id: key })).value,
    setVerify: async (key, v) => {
      await setVerify($, key, v)
    },
    runVerify: key => runVerify($, key),
    openRef: async ref => {
      const c = citations(`[[${ref}]]`)[0]
      if (c) await openPlace($, c)
    },
    checkCites: async text => {
      const cs = citations(text)
      remember(cs)
      await check($, cs, true)
      let bad = 0
      for (const c of cs) {
        const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
        if (v?.status === 'missing' || v?.status === 'differs') bad++
      }
      return bad
    },
  }
}

/** A card in a report: the interactive card, a mark lit at `focus` (a story's step), drawn from `data` when given (a
 *  slide's card cut to fit); drawn plain off the terminal. */
async function reportCard($: Dollar, e: ResolveInput, id: string, width: number, key: string, focus?: Focus, data?: CardData): Promise<RenderElement> {
  const loaded = data ?? (await loadCard($, id))
  const card = loaded ? await labelled($, loaded) : null
  const { Text } = $.ui.resolve(e)
  if (!card) return <Text key={key} color={COLORS.problem} wrap="wrap">{`× this card cannot be drawn: ${(await cardFile($, id)).why}`}</Text>
  await $.state.get({ ...RUNS, id }) // a finished run redraws the card
  // off the terminal, the card in its frame as the mod draws it; on it, card.tsx draws the frame
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return framedCard($, e, card, width, undefined, key)
  const { Client } = $.ui.resolve(e as ResolveInput<'Pane', 'terminal'>)
  return <Client key={key} module="./card.tsx" width={width} props={{ card, cols: width, debug, meta: await metaOf($, id), ...(focus ? { focus } : {}) }} />
}

/** What main (or a subagent) is told of a Bash output saved as call:<short>, so it can cite its lines. */
function callNote(short: string): string {
  return `thimble-cc-mod: this output is call:${short}. To cite a line of it, write [[<value>|call:${short}#L<n>]], counting the output's lines from 1.`
}

const subagentBash = new Map<string, string>() // a Bash call of a subagent of the mod not answered yet: its id -> its command

type RowBlock = { type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; content?: unknown }

/** A row of a subagent of the mod: its Bash calls remembered, and each one's output saved (.thimble-cc-mod/calls/) with
 *  a note after it of how to cite its lines, as main's outputs are (a side thread's numbers cite its own commands). */
async function subagentCalls($: Dollar, agentId: string, door: string, msg: SessionAppendMessage): Promise<SessionAppendMessage> {
  if (door !== 'response' && door !== 'tool-result') return msg
  if (!(await agentOf($, agentId)) && !viewAgentOf(agentId)) return msg
  const blocks = msg.content as unknown as RowBlock[]
  if (door === 'response') {
    for (const b of blocks) if (b.type === 'tool_use' && b.name === 'Bash' && b.id) subagentBash.set(b.id, String(b.input?.command ?? ''))
    return msg
  }
  await paths($)
  let changed = false
  const out: RowBlock[] = []
  for (const b of blocks) {
    const command = b.type === 'tool_result' && b.tool_use_id ? subagentBash.get(b.tool_use_id) : undefined
    if (command === undefined || !b.tool_use_id) {
      out.push(b)
      continue
    }
    subagentBash.delete(b.tool_use_id)
    const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? (b.content as { type?: string; text?: string }[]) : []
    const text = parts.filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n')
    // a view an orientation proposed is taken up at once, as main's are (its command may name the helper by a variable)
    if (touchesProposals('Bash', { command }) || /^proposed the view /m.test(text)) void scanProposals($)
    const short = cid(b.tool_use_id)
    const saved = text.trim()
      ? await $.fs.write(`${cwd}/${HOME}/calls/${short}.json`, JSON.stringify({ id: short, tool_use_id: b.tool_use_id, command, output: text })).then(() => true, () => false)
      : false
    if (!saved) {
      out.push(b)
      continue
    }
    out.push({ ...b, content: [...parts, { type: 'text', text: callNote(short) }] })
    changed = true
  }
  return changed ? { ...msg, content: out as unknown as SessionAppendMessage['content'] } : msg
}

/** The panel as `draw` draws it. A later drawing may still begin while this one runs (paneTurns waits two seconds at
 *  most): Claude Code shows the later one but keeps the buttons and fields of whichever settles last, so should this one
 *  settle last, or be abandoned, the shown panel's buttons and fields would do nothing. The panel then draws once more
 *  after it. */
async function panelDrawn($: Dollar, next: { readonly signal: AbortSignal }, s: { draws: number; redrawing: boolean }, draw: () => Promise<RenderElement>): Promise<RenderElement> {
  const n = ++s.draws
  await read($, panelRedrawA)
  const tree = await draw()
  if ((n !== s.draws || next.signal.aborted) && !s.redrawing) {
    s.redrawing = true
    $.clock.after(50, () => {
      s.redrawing = false
      void update($, panelRedrawA, k => (k ?? 0) + 1)
    })
  }
  return tree
}

export const register: Register = on => {
  let turnParts: Part[] = [{ rows: [] }] // this turn's text rows in main (their uuids and text), by part
  let turnPrompt = ''
  // the question an answer answers: the analyst's prompt, kept through the turns a task's notification starts (a
  // workflow's end), whose answers go on with it
  let turnHead = ''
  // the terminal's width as each command runs, for the panel's width (openPane)
  on('command.run', async ($, e, next) => {
    if (e.presentation?.columns > 0) termColumns = e.presentation.columns
    await navOrigin($, false)
    return next(e)
  })
  // the one ui.render hook of the panel draws the view `panelView` names (drawCite, drawCard, drawThreads, …),
  // each drawing once the one before it has settled (turns.ts), or two seconds at most; one that still settles after a
  // later one began, or that Claude Code abandoned, is followed by one more (panelDrawn)
  const panel = { draws: 0, redrawing: false }
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, pe, next) => paneTurns.run(() => panelDrawn($, next, panel, async () => {
    measurePanel($, pe)
    // the panel's top row is its way (back, the breadcrumb, the threads tree); the view below it has a row less
    const e = inset(lessRows(pe, 1))
    return withWay($, e, await (async () => { switch ((await read($, viewA)) as PanelView) {
      case 'card':
        return drawCard($, e)
      case 'thread':
        return drawThreads($, e, await read($, threadA))
      case 'threads':
        return drawThreads($, e)
      case 'view':
        await paths($)
        return drawViewPane($, e, `${cwd}/${HOME}`, () => void closePanel($))
      case 'views':
        return drawPipePane($, e)
      case 'report':
        return drawReport(e, reportCtx($))
      case 'reports':
        return drawReports(e, reportCtx($))
      case 'coverage':
        return drawCoverage(e, harnessCtx($))
      case 'label':
        return drawLabel(e, harnessCtx($))
      case 'labels':
        return drawLabels(e, harnessCtx($))
      case 'home':
        return drawHome($, e)
      default:
        return drawCite($, e)
    } })())
  }), fire => $.clock.after(2000, fire)))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionAt = await $.clock.now().catch(() => Date.now())
    await ensureGuide($)
    await loadDebug($)
    // the card helper writes cards here, wherever a script runs: every Bash command and process started after inherits it
    await $.env.set('THIMBLE_CC_MOD_ROOT', cwd).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not set THIMBLE_CC_MOD_ROOT: ${String(err).slice(0, 120)}`))
    await loadCorrections($)
    await loadMarks($)
    await loadNotes($)
    await loadSignals($)
    await scanProposals($)
    $.clock.every(150, () => void flushQueue($))
    await $.command.register({ name: 'thimble-card', description: 'Open a card of the last reply in a pane: /thimble-card <n>' })
    await $.command.register({ name: 'thimble-cite', description: 'Open the panel of a citation of the last reply: /thimble-cite <n>', immediate: true })
    await $.command.register({ name: 'thimble-check', description: 'Check the citations of the last reply again', immediate: true })
    await $.command.register({ name: 'thimble-threads', description: 'Every side thread as a tree, each under the thread it was asked from, with what it is doing and its unread answers: reopen one to read or continue it', immediate: true })
    await $.command.register({ name: 'thimble-ask', description: 'Ask a side thread about the last reply, out of the main chat: /thimble-ask <question>', immediate: true })
    await $.command.register({ name: 'thimble-view', description: 'Open a view of this folder in the panel: /thimble-view <name>', immediate: true })
    await $.command.register({ name: 'thimble-views', description: 'The proposed and built views of this folder: /thimble-views [build] <name>', immediate: true })
    await $.command.register({ name: 'thimble-band', description: 'Show or hide the band of the last reply\'s citations above the prompt', immediate: true })
    await $.command.register({ name: 'thimble-files', description: 'Browse the folder\'s files in the panel: /thimble-files [path[:line]]', immediate: true })
    // reports (reports.tsx): main's `report` tool, and the commands
    await $.tool.register({ name: 'report', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA }).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not offer the report tool: ${String(err).slice(0, 160)}`))
    await $.tool.register({ name: 'report_highlight', description: HIGHLIGHT_DESCRIPTION, inputSchema: HIGHLIGHT_SCHEMA }).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not offer the report_highlight tool: ${String(err).slice(0, 160)}`))
    await $.command.register({ name: 'thimble-report', description: REPORT_COMMAND_DESCRIPTION, immediate: true })
    await $.command.register({ name: 'thimble-reports', description: 'Every report in this folder: open one in the panel', immediate: true })
    await $.command.register({ name: 'thimble-cc-mod', description: 'thimble-cc-mod status; /thimble-cc-mod debug on|off writes the mouse log or stops it', immediate: true })
    // the harness (harness.tsx): Python's opens noted for the coverage count, the label tool, its commands
    await $.env.set('THIMBLE_CC_MOD_SESSION', await $.session.id().catch(() => '')).catch(() => undefined)
    const pyPath = (await $.env.get('PYTHONPATH')) ?? ''
    if (!pyPath.split(':').includes(`${root}/helper/pyaudit`)) await $.env.set('PYTHONPATH', [`${root}/helper/pyaudit`, ...(pyPath ? [pyPath] : [])].join(':')).catch(() => undefined)
    await $.tool.register({ name: 'label', description: LABEL_DESCRIPTION, inputSchema: LABEL_SCHEMA }).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not offer the label tool: ${String(err).slice(0, 160)}`))
    await $.command.register({ name: 'thimble-coverage', description: 'What this session has read of the files here: each file, the lines read, and what was never opened', immediate: true })
    // the orientation and labels: one interface for the analyst (these commands) and main (the orient and label tools), hooks/commands.ts
    await $.tool.register({ name: 'orient', description: ORIENT_DESCRIPTION, inputSchema: ORIENT_SCHEMA }).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not offer the orient tool: ${String(err).slice(0, 160)}`))
    await $.command.register({ name: 'thimble-orient', description: 'Orient: a subagent surveys every file and writes a short document in the panel, with a deck of cards, views and a report unless turned off, and a critique when turned on', argumentHint: '[focus] [--no-deck] [--no-views] [--critique] [--no-report]', immediate: true })
    await $.command.register({ name: 'thimble-label', description: 'Define and apply a label, or list the labels or open one', argumentHint: '[list | open <name> | <name> kind= definition= paths= values= limit=]', immediate: true })
    await $.command.register({ name: 'thimble-home', description: 'Everything made in this folder in one panel: views, reports, threads, cards, labels and files', immediate: true })
    // a resumed session: the band lists the last reply's citations
    try {
      const rows = await $.session.messages()
      const last: string[] = []
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!
        if (r.role === 'user' && r.text.trim() && !r.toolResults?.length) break
        if (r.role === 'assistant' && r.text.trim()) last.unshift(r.text)
      }
      const text = last.join('\n\n')
      lastReply = text
      if (embeddedCards(text).length) lastCards = embeddedCards(text)
      // the rows' uuids are not listed: the band's claims are those of the last answer kept in the marks when the reply
      // holds its rows (so they share its fixes and verifications), else the resumed reply's own
      const end = marks.last ? marks.ends[marks.last] : undefined
      const corrections = (await read($, correctionsA)) ?? []
      const own = end?.rows.length && end.rows.every(r => text.includes(r.text)) ? end.rows : null
      const cls = own ? own.flatMap(r => claimsIn(applyCorrections(r.text, corrections, r.id), r.id)) : claimsIn(text, 'resumed')
      if (cls.length) {
        rememberClaims(cls)
        await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { id: own ? marks.last : 'resumed', ids: cls.map(cl => cl.key) })
        enqueue($, cls.map(cl => cl.c))
      }
    } catch {
      // nothing to resume
    }
    return started
  })

  // The mod's subagents end with the session. /exit stops them, and waits until Claude Code sees them ended, before it
  // looks for running ones (it would ask whether to stop them or move the conversation to the background); ctrl+c and
  // the other ends reach session.end.
  on('command.run', { command: 'exit' }, async ($, e, next) => {
    await untilEnded($, await endRunning($, '/exit'))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await endRunning($, `the session ends (${e.reason})`).catch(() => undefined)
    return next(e)
  })

  // The panel closed by the person or another plugin (the mod's own closes go through closePanel and do not reach its
  // hooks). A thread it showed answers on.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANEL) await $.state.set({ plugin: 'thimble-cc-mod', key: 'pending' }, null)
    const closed = await next(e)
    if (e.id === PANEL) await $.state.set({ plugin: 'thimble-cc-mod', key: 'panelView' }, '')
    return closed
  })

  // The guidance rides along with the first prompt of a conversation, as context the model reads and the analyst does
  // not see. Not as a section of the system prompt (prompt.compose), since managed settings can bypass a user
  // plugin's prompt.compose hook.
  on('prompt.submit', async ($, e, next) => {
    // A fork of main ends without any notice to main. A general-purpose subagent (the fallback where a fork is
    // refused) hands its report back to main, a delivery that reaches only this hook (not session.receive,
    // session.send or tool.call: checked live on 2.1.289), so main would answer it in its chat: the report is taken as
    // the subagent's answer and the prompt dropped, which Claude Code shows as one line. A task notification of the
    // mod's subagents is dropped too.
    const from = handbackFrom(e.origin, e.text)
    const sender = from ? ((await agentOf($, from)) ?? viewAgentOf(from)) : undefined
    await logEvent($, { event: 'prompt', origin: e.origin.kind, from: from ?? '', mine: String(Boolean(sender)), during: e.turnId ?? '', text: clip(e.text, 160) })
    if (from && sender) {
      handbacks.set(from, handbackReport(e.text))
      return { drop: `thimble-cc-mod: ${sender.label} · reported` }
    }
    if (e.origin.kind === 'task-notification' && (await modAgentIn($, e.text))) return { drop: 'thimble-cc-mod: a subagent of the mod ended' }
    const g = await ensureGuide($)
    // the guidance goes as hook context, which no row of $.session.messages() holds, so it is sent once and again
    // after a compaction
    let guideNow = false
    if (g && !guideSent) {
      guideSent = true
      try {
        guideNow = !(await $.session.messages()).some(r => r.role === 'user' && r.text.includes(GUIDE_MARK))
      } catch {
        guideNow = true
      }
    }
    // the notes left for main since its last prompt go with this one
    const waiting = await takeNotes($)
    // what this session has read of the corpus (harness.tsx), so main knows what it has not opened
    const coverageLine = from || e.origin.kind === 'task-notification' ? '' : (await coverageContext(harnessCtx($))).replace('{{helper}}', `${root}/helper`)
    const context = [...(e.context ?? []), ...(guideNow ? [g] : []), ...waiting, ...(coverageLine ? [coverageLine] : [])]
    const r = await next(context.length === (e.context ?? []).length ? e : { ...e, context })
    // a prompt dropped beneath leaves its notes for the next one
    if (r.drop !== undefined && waiting.length) {
      notes = [...waiting, ...notes]
      await saveNotes($)
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!('skip' in r && r.skip)) guideSent = false
    return r
  })

  // citations typed or put in the prompt are painted as chips there too
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    const decorations = citeSpans(r.text).map(sp => chipDecoration(r.text.slice(sp.at, sp.end), sp.at))
    return decorations.length ? { ...r, decorations: [...(r.decorations ?? []), ...decorations] } : r
  })

  // ---------------------------------------------------------------------------------------------- Bash outputs

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // a proposal made or changed: the row above the prompt shows it, and one asked to be built starts building
    if (ran.deny === undefined && touchesProposals(e.tool, e as unknown as Record<string, unknown>)) void scanProposals($)
    if (e.tool !== 'Bash' || ran.deny !== undefined || !ran.text || !ran.text.trim()) return ran
    await paths($)
    const short = cid(e.tool_use_id)
    try {
      await $.fs.write(`${cwd}/${HOME}/calls/${short}.json`, JSON.stringify({ id: short, tool_use_id: e.tool_use_id, command: String((e as { command?: unknown }).command ?? ''), output: ran.text }))
    } catch {
      return ran
    }
    return { ...ran, context: [...(ran.context ?? []), callNote(short)] }
  })

  // ---------------------------------------------------------------------------------------------- turns

  on('turn.start', async ($, e, next) => {
    mainBusy = true
    turnParts = [{ rows: [] }]
    turnPrompt = e.text
    if (!/^\s*<task-notification/.test(e.text) || !turnHead) turnHead = e.text.split('\n')[0] ?? ''
    return next(e)
  })

  // main's reply as it streams: citations as links and card lines as placeholders, never their raw spelling
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await paths($)
    const blocks = new Map<number, Streaming>()
    const questions = new Map<string, string>()
    const look = streamLook(questions)
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
        for (const m of `${st.raw.slice(st.done)}${ch.text}`.matchAll(/\[\[card:([A-Za-z0-9_-]+)\]\]/g)) {
          if (!questions.has(m[1]!)) questions.set(m[1]!, (await cardFile($, m[1]!)).data?.question ?? '')
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

  on('session.append', async ($, e, next) => {
    let msg = e.message
    if (e.door === 'response' && e.agentId === undefined && Array.isArray(msg.content)) {
      // a block of main's reply is stored as the model wrote it, not as it showed while it streamed
      const shown = msg.content as { type?: string; text?: string }[]
      const blocks = shown.map(b => (b.type === 'text' && typeof b.text === 'string' && asWritten.has(b.text) ? { ...b, text: asWritten.get(b.text)! } : b))
      if (blocks.some((b, i) => b !== shown[i])) msg = { ...msg, content: blocks as typeof msg.content }
      const texts = blocks.flatMap(b => (b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [b.text] : []))
      if (texts.length) turnParts.at(-1)!.rows.push({ id: e.uuid, text: texts.join('\n\n') })
      if (blocks.some(b => b.type === 'tool_use')) turnParts.push({ rows: [] })
    }
    // a Bash output of a subagent of the mod is saved and noted as main's is (tool.call does not reach a fork's tools)
    if (e.agentId !== undefined && Array.isArray(msg.content)) msg = await subagentCalls($, e.agentId, e.door, msg)
    // the latest row of main's chat a side thread's answer can be told under (hooks/signal.ts), by the id it is stored
    // under
    if (e.agentId === undefined && isAnchor(e)) await anchorAt($, e.uuid)
    const stored = await next(msg === e.message ? e : { ...e, message: msg })
    // every agent's reads of the corpus, for the coverage count (harness.tsx)
    coverageAppend(harnessCtx($), e.agentId, e.door, e.message.content)
    if (e.agentId !== undefined) {
      await threadAppend($, e.agentId, e.door, e.message.content)
      await pipeStep($, e.agentId, e.message.content)
      await reportAppend(reportCtx($), e.agentId, e.door, e.message.content)
    }
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      await paths($)
      const a = (await agentOf($, e.agentId)) ?? viewAgentOf(e.agentId)
      if (!a) return done
      // its result is in: the subagent is stopped once the engine has recorded its end
      const id = e.agentId
      $.clock.after(500, () => void endSub($, id, `${a.kind} ${e.reason === 'answer' ? 'answered' : `ended: ${e.reason}`}`))
      // its answer: a fork's last message, or the report a general-purpose fallback handed back (prompt.submit),
      // which can reach the mod just after its end
      if (!a.kind.startsWith('view-') && !handbacks.has(id) && !e.answer.trim()) {
        $.clock.after(1000, () => void subAnswered($, id, a, e.reason, e.answer))
        return done
      }
      if (!a.kind.startsWith('view-')) {
        await subAnswered($, id, a, e.reason, e.answer)
        return done
      }
      // a view's builder or reviewer: the checks and the next step run apart from the turn's end
      // after a reload of the hooks the proposals are read again, so the build is taken up where it stands
      if (!pipes.size) await scanProposals($)
      $.clock.after(1000, () => {
        const said = handbacks.get(id) || e.answer
        handbacks.delete(id)
        void (a.kind === 'view-build' ? buildComplete($, id, a, e.reason) : reviewComplete($, id, a, e.reason, said))
      })
      return done
    }
    const rows = turnParts.flatMap(p => p.rows)
    const text = rows.length ? rows.map(r => r.text).join('\n\n') : e.answer
    lastReply = text
    const cls = rows.flatMap(r => claimsIn(r.text, r.id))
    rememberClaims(cls)
    const cs = citations(text)
    remember(cs)
    if (cs.length) {
      await check($, cs, true) // again, at the turn's end: a card may have changed since the block was drawn
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { id: e.turnId, ids: cls.map(cl => cl.key) })
    }
    // the answer (not what main wrote while it worked) as a file the analyst owns, and a summary line under its last row
    const part = answerPart(turnParts)
    const answer = part ? part.rows.map(r => r.text).join('\n\n') : e.answer
    const answerCites = citations(answer)
    const cardsOf = embeddedCards(answer)
    if (embeddedCards(text).length) lastCards = embeddedCards(text)
    const lastRow = part?.rows.at(-1)?.id ?? ''
    let end: ChatEnd | undefined
    if (answer.trim() && (answerCites.length || cardsOf.length) && !fromMod(turnPrompt)) {
      await paths($)
      const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      end = { rows: part?.rows.length ? part.rows : [{ id: lastRow, text: answer }], cards: cardsOf, file: `${HOME}/answers/${stamp}.md`, head: turnHead }
      try {
        await $.fs.write(`${cwd}/${end.file}`, `# ${end.head}\n\n${answer}\n`)
      } catch {
        // the answer stays in the transcript
      }
      if (lastRow) await setEnd($, lastRow, end, true)
    }
    // a card that cannot be drawn or a citation that fails goes to a fix round, out of main's chat
    if (text.trim() && !fromMod(turnPrompt)) await startFix($, text, rows, lastRow, end)
    await mainEnded($)
    // the views this turn proposed: their rows under its answer
    await attachPendingViews($, lastRow)
    // an answer that speaks for the whole corpus while a kind of file was never opened: the check shows under the
    // answer, and main reads the same words with the analyst's next prompt. Main starts no turn for it.
    if (!fromMod(turnPrompt) && !e.isAborted && lastRow) {
      await paths($)
      const missed = await coverageAfterTurn(harnessCtx($), answer).catch(() => null)
      if (missed) {
        await setEnd($, lastRow, { ...(end ?? { rows: part?.rows.length ? part.rows : [{ id: lastRow, text: answer }], cards: cardsOf, file: '', head: turnHead }), check: missed }, true)
        await noteMain($, checkNote(missed, `${root}/helper`))
        await logEvent($, { event: 'coverage check', row: lastRow })
      }
    }
    return done
  })

  // ---------------------------------------------------------------------------------------------- the reply

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const end = (await $.state.get({ ...ENDS, id: e.requestId })).value
    // on the terminal and the desktop the mod draws every reply, so any of its text selects and takes "ask about
    // this"; elsewhere only a reply with citations or cards
    const live = e.surface === 'terminal' || e.surface === 'desktop'
    // the side threads that answered while main's chat ended in this row (hooks/signal.ts)
    const told = await signalRows($, e)
    if (!live && !needsDrawing(e.props.text) && !end) {
      if (!told) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box flexDirection="column">{await next(e)}{told}</Box>
    }
    // only the corrections made for this row: the same sentence in another answer is that answer's own
    const corrections = (await read($, correctionsA)) ?? []
    const text = applyCorrections(e.props.text, corrections, e.requestId)
    const cs = citations(text)
    remember(cs)
    const unchecked: Citation[] = []
    for (const c of cs) if (!(await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value) unchecked.push(c)
    if (unchecked.length) enqueue($, unchecked)
    const { Box, Text, Button } = $.ui.resolve(e)
    const out = await drawReply($, e, text, (e.viewport?.columns ?? 100) - 2 - MARGIN, e.requestId, '', Boolean(e.props.isFirstOfReply))
    if (end?.file) {
      // the footer, one blank row under the answer: its citations and cards dim, the problems left counted from the
      // answer's rows as drawn now (their corrections in place), in red; its controls after a gutter. No file path.
      const left = { problem: 0, fixing: 0, failed: 0, link: 0 }
      const cls = new Map<string, Claim>()
      for (const r of end.rows) for (const cl of claimsIn(applyCorrections(r.text, corrections, r.id), r.id)) cls.set(cl.key, cl)
      for (const cl of cls.values()) {
        const v = (await $.state.get({ ...VERDICTS, id: cid(cl.c.raw) })).value
        const f = (await $.state.get({ ...FIXES, id: cl.key })).value
        const r = (await $.state.get({ ...VERIFY, id: cl.key })).value
        left[chipState(v?.status, f?.state, r?.state)]++
      }
      const red = left.problem + left.failed
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
      // the whole answer (all its rows, as corrected) for "ask about this answer ›": a side thread, out of main's chat
      const whole = end.rows.map(r => applyCorrections(r.text, corrections, r.id)).join('\n\n')
      out.push(
        <Box key={`footer:${e.requestId}`} marginTop={1} marginLeft={MARGIN} flexDirection="row" columnGap={2}>
          <Box key={`footer-words:${e.requestId}`} flexShrink={1} flexDirection="row">
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">{[plural(cls.size, 'citation'), ...(end.cards.length ? [plural(end.cards.length, 'card')] : [])].join(' · ')}</Text>
            </Box>
            {left.fixing || red ? (
              <Box key={`footer-left:${e.requestId}`} flexShrink={0}>
                <Text>
                  {left.fixing ? <Text dimColor>{` · ◌ fixing ${left.fixing}`}</Text> : null}
                  {red ? <Text color={COLORS.problem}>{` · ${plural(red, 'problem')}`}</Text> : null}
                </Text>
              </Box>
            ) : null}
          </Box>
          <Button
            key={`ask-answer:${e.requestId}`}
            label="ask about this answer ›"
            plain
            onPress={() => void openThread($, { label: 'this answer', context: `The answer the analyst asks about:\n${clip(whole, 6000)}` })}
          />
          <Button
            key={`as-report:${e.requestId}`}
            label="open as report"
            plain
            onPress={() => void openAsReport(reportCtx($), whole, end.head)}
          />
        </Box>,
      )
    }
    // the coverage check of the answer, whole, under it: main reads the same words with the analyst's next prompt
    if (end?.check) {
      out.push(
        <Box key={`check:${e.requestId}`} marginTop={1} marginLeft={MARGIN} flexDirection="row">
          <Box width={10} flexShrink={0}>
            <Text dimColor>coverage</Text>
          </Box>
          <Box flexShrink={1}>
            <Text dimColor wrap="wrap">{end.check.replace(/^Coverage check: /, '')}</Text>
          </Box>
        </Box>,
      )
    }
    if (told) out.push(told)
    // each block brings its own margin (the ⏺ on the first, its "?" on hover): drawReply
    return <Box flexDirection="column">{out}</Box>
  })

  // the other rows of main's chat a side thread's answer is told under (hooks/signal.ts): the analyst's prompt, the
  // turn's duration, a command's output, each as the engine draws it, then one row per answer
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    const told = await signalRows($, e)
    if (!told) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{await next(e)}{told}</Box>
  })
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const told = await signalRows($, e)
    if (!told) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{await next(e)}{told}</Box>
  })
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const told = await signalRows($, e)
    if (!told) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{await next(e)}{told}</Box>
  })

  // a row of main's chat a subagent of the mod causes, should one reach it (Claude Code's row of its end, its Agent
  // row): one dim line by its name; ctrl+o shows it whole
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    const a = await agentOf($, e.props.task?.id)
    if (e.props.isExpanded || (!a && !MOD_AGENT.test(e.props.text))) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{`  ${a?.label ?? 'a thimble-cc-mod subagent'} · ${noticeWord(e.props.task?.status)}`}</Text>
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    const d = (e.props.input as { description?: unknown } | undefined)?.description
    if (typeof d !== 'string' || !MOD_AGENT.test(d)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{`  ${d}${e.props.isRunning ? ' · running' : ''}`}</Text>
  })

  // ---------------------------------------------------------------------------------------------- clicks

  // a card's title is a Button (card.tsx): its press is the person's own, so the card's thread opens at any width
  on('ui.press', async ($, e, next) => {
    await navOrigin($, e.component === 'Pane' && e.requestId === PANEL)
    const id = /^card-title:([A-Za-z0-9_-]+)$/.exec(e.element)?.[1]
    if (id) await act($, 'thread', { kind: 'card', ref: `card:${id}`, cardId: id })
    // "ask about this" beside a selection in a paragraph (para.tsx): a thread about the words selected
    if (e.element === 'sel-ask' && selection) await act($, 'thread', { kind: 'sentence', text: selection.slice(0, 1200) })
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const d = (e.data ?? {}) as { type?: string; id?: string; card?: string; act?: string; name?: string; value?: string; ev?: unknown; origin?: string; gestures?: unknown }
    // every post of a Client that uses hooks/gestures.tsx carries its recent gestures; each is handled once
    if (Array.isArray(d.gestures) && typeof d.origin === 'string') {
      const last = seen.get(d.origin) ?? 0
      const fresh = (d.gestures as Sent[]).filter(g => typeof g?.seq === 'number' && g.seq > last)
      if (fresh.length) seen.set(d.origin, Math.max(...fresh.map(g => g.seq)))
      for (const g of fresh) {
        if (debug) await logMouse($, e.module, g)
        if (!g.gesture || !g.target) continue
        await navOrigin($, e.component === 'Pane' && e.requestId === PANEL)
        clicking++
        try {
          await onGesture($, g.gesture, g.target, g.ev)
        } catch (err) {
          await logEvent($, { event: 'gesture failed', gesture: g.gesture, error: clip(String(err), 300) })
          $.ui.log(`thimble-cc-mod: the ${g.gesture} gesture failed: ${clip(String(err), 200)}`)
        } finally {
          clicking--
        }
      }
    } else if (debug && (d.ev || d.type === 'act' || d.type === 'param')) {
      await writeMouseLog($, JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), module: e.module, ...d }))
    }
    if (d.type === 'pointer' || d.type === 'gesture') return next(e)
    // a panel drawn from lines (homeview.tsx): its clicks and keys, by the drawing each was made in
    if (d.type === 'home') {
      await navOrigin($, e.component === 'Pane' && e.requestId === PANEL)
      clicking++
      try {
        await linesMessage($, (d as { horigin?: unknown }).horigin, (d as { hacts?: unknown }).hacts)
      } finally {
        clicking--
      }
      return next(e)
    }
    if (d.type === 'view') {
      await navOrigin($, true)
      await paths($)
      await viewEffects($, await viewMessage($, `${cwd}/${HOME}`, d as never))
      return next(e)
    }
    if (d.type === 'copy' && typeof (d as { text?: unknown }).text === 'string') {
      const text = (d as { text: string }).text.slice(0, 100000)
      selection = text
      const r = await $.ui.copy({ text, surface: e.surface })
      $.ui.toast(r.isCopied ? `copied ${text.length} characters` : `could not copy: ${r.reason}`)
      return next(e)
    }
    if (d.type === 'report-nav' && typeof (d as { op?: unknown }).op === 'string') {
      await reportNav(reportCtx($), (d as { op: string }).op)
      return next(e)
    }
    if (d.type === 'hover') {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'hover' }, typeof d.id === 'string' ? d.id : '')
      return next(e)
    }
    if (d.type === 'param' && typeof d.card === 'string' && typeof d.name === 'string' && typeof d.value === 'string') {
      void rerunCard($, d.card, { name: d.name, value: d.value })
      return next(e)
    }
    // a card's label line (card.tsx): the label in the panel; a label card's "agree" or "disagree": the label's verdict
    const lb = d as { slug?: unknown; ref?: unknown }
    if (d.type === 'label-open' && typeof lb.slug === 'string') {
      await navOrigin($, e.component === 'Pane' && e.requestId === PANEL)
      if (!(await openLabel(harnessCtx($), lb.slug))) $.ui.toast(`no label ${lb.slug} in this folder`)
      return next(e)
    }
    if (d.type === 'label-verdict' && typeof lb.slug === 'string' && typeof lb.ref === 'string' && typeof d.value === 'string') {
      void labelVerdict(harnessCtx($), lb.slug, lb.ref, d.value)
      return next(e)
    }
    return next(e)
  })

  // ---------------------------------------------------------------------------------------------- citation panel


  // ---------------------------------------------------------------------------------------------- side thread pane


  // ---------------------------------------------------------------------------------------------- band (opt-in)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the row spans the terminal less a docked pane: with none of the mod's seated, it measures the terminal
    const panes = await $.ui.panes().catch(() => [])
    if (e.surface === 'terminal' && e.viewport?.columns && !panes.some(p => p.isPlaced)) termColumns = e.viewport.columns
    if (e.props.hasSurvey || e.props.view.agentId) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // a pane a click opened that waits undrawn (the engine's, or held by openPane), until it is drawn or closed
    const pending = await read($, pendingA)
    const waits = pending ? !panes.some(p => p.id === pending.id && p.isPlaced) : false
    const offer =
      pending && waits ? (
        <Box flexDirection="row">
          <Box width={ABOVE_LABEL} flexShrink={0}>
            <Text dimColor>{'  panel'}</Text>
          </Box>
          <Box flexDirection="row" columnGap={2}>
            <Text>{`${clip(pending.title, 40)} is ready`}</Text>
            <Button
              key="pending"
              label="open panel"
              plain
              onPress={async () => {
                await $.state.set({ plugin: 'thimble-cc-mod', key: 'pending' }, null)
                const r = await $.ui.open({ ...pending, columns: panelColumns() })
                await logEvent($, { event: 'pane', result: r.isPlaced ? 'placed from the row above the prompt' : `still waits: ${r.reason}` })
              }}
            />
            <Button key="pending-x" label="dismiss" plain onPress={() => void closePanel($)} />
          </Box>
        </Box>
      ) : null
    // the rows above the prompt are gone (views/SPEC.md, "Main's chat"): threads and views show as `↳` rows under the
    // answer, coverage in home's Files section; only a panel a click opened that waits undrawn is offered here
    const above = offer
    if (!(await read($, bandA))) return above ?? next(e)
    const turn = await read($, turnA)
    if (!turn || turn.ids.length === 0 || (await read($, hiddenA)) === turn.id) return above ?? next(e)
    const views: { id: string; c: Citation; view: ChipView }[] = []
    for (const id of turn.ids) {
      const cl = claimMap.get(id)
      if (cl) views.push({ id, c: cl.c, view: await chipView($, cl) })
    }
    const bad = views.filter(x => x.view.state !== 'link').length
    const hoverId = await read($, hoverA)
    const hc = hoverId ? claimMap.get(hoverId) : undefined
    const hview = hc ? await chipView($, hc) : undefined
    // the readout row stays when nothing is hovered, so the band keeps its height and the transcript does not move
    const readout = hview ? paintLine(Text, [...chipSegs(hview, false), { s: `  ${hview.tip}`, d: true }]) : <Text> </Text>
    return (
      <Box flexDirection="column">
        {offer}
        {readout}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text>thimble-cc-mod</Text>
          <Text dimColor>{`${views.length} citation${views.length === 1 ? '' : 's'}`}</Text>
          {bad ? <Text color={COLORS.problem}>{`· ${bad} with a problem`}</Text> : null}
          <Text dimColor>·</Text>
          {views.slice(0, 9).map((x, i) => (
            <Button key={`c${i}`} label={`${cut(x.view.label, 14)}${x.view.mark}`} hotkey={String(i + 1)} plain onPress={() => void openCitation($, x.c, x.id)} />
          ))}
          <Button key="hide" label="hide" plain dimColor onPress={() => update($, hiddenA, () => turn.id)} />
        </Box>
      </Box>
    )
  })

  // ---------------------------------------------------------------------------------------------- commands

  on('command.run', { command: 'thimble-cite' }, async ($, e) => {
    const turn = await read($, turnA)
    const n = Number.parseInt(e.args.trim() || '1', 10)
    const id = turn?.ids[n - 1]
    const c = id ? citeOf(id) : undefined
    if (!id || !c) return { text: `the last reply has ${turn?.ids.length ?? 0} citations` }
    await openCitation($, c, id)
    return { text: `opened ${citeTitle(c)}` }
  })

  on('command.run', { command: 'thimble-band' }, async $ => {
    const on_ = !(await read($, bandA))
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'band' }, on_)
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'hidden' }, '')
    return { text: `the citation band is ${on_ ? 'on (digits 1-9 in the empty prompt open a citation)' : 'off'}` }
  })

  on('command.run', { command: 'thimble-threads' }, async $ => {
    await openPane($, 'threads', 'Threads')
    const n = (await allThreads($)).length
    return { text: `${n} side thread${n === 1 ? '' : 's'}` }
  })

  on('command.run', { command: 'thimble-ask' }, async ($, e) => {
    const q = e.args.trim()
    const reply = lastReply
    const id = await openThread($, { label: 'the last answer', context: reply ? `The last answer in the main conversation:\n${clip(reply, 3000)}` : '' })
    if (q) void askThread($, id, q, await ensureGuide($))
    // the command's text holds the prompt while it runs, so the pane could not take the keys: once the prompt is
    // empty, its field takes them, so a follow-up typed next goes to this thread
    $.clock.after(250, () => {
      void (async () => {
        await $.ui.open({ id: PANEL, title: 'Threads', focus: true, columns: panelColumns() }).catch(() => undefined)
        await $.ui.focus({ requestId: PANEL, key: askKey(id) }).catch(() => undefined)
      })()
    })
    return { text: `side thread opened${q ? `: ${q}` : ''}` }
  })

  on('command.run', { command: 'thimble-cc-mod' }, async ($, e) => {
    await paths($)
    const [word, value = ''] = e.args.trim().split(/\s+/)
    if (word === 'debug') {
      if (value !== 'on' && value !== 'off') return { text: `the mouse log is ${debug ? 'on' : 'off'}: /thimble-cc-mod debug on|off` }
      try {
        await $.fs.write(`${cwd}/${DEBUG_FLAG}`, `${value}\n`)
      } catch (err) {
        return { text: `could not write ${DEBUG_FLAG}: ${String(err).slice(0, 160)}` }
      }
      debug = value === 'on'
      return { text: debug ? `the mouse log is on: ${cwd}/${HOME}/mouse.log` : 'the mouse log is off' }
    }
    const g = await ensureGuide($)
    const present = guideSent || (await $.session.messages()).some(r => r.role === 'user' && r.text.includes(GUIDE_MARK))
    const count = async (dir: string) => {
      try {
        return (await $.fs.list(`${cwd}/${HOME}/${dir}`)).length
      } catch {
        return 0
      }
    }
    return {
      text: [
        `plugin folder: ${root}`,
        `guidance: ${g ? `${g.length} characters, ${present ? 'in this conversation' : 'goes with the next prompt'}` : 'not loaded'}`,
        `in ${cwd}/${HOME}: ${await count('cards')} cards, ${await count('answers')} answers, ${await count('threads')} side threads, ${await count('verify')} verification scripts`,
        `mouse log: ${debug ? `on (${HOME}/mouse.log)` : 'off (/thimble-cc-mod debug on)'}`,
        `${SCRIPTS.replace(/^the /, '')}: ${(await sandboxPlan($)).line}`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'thimble-check' }, async $ => {
    const turn = await read($, turnA)
    const cs = [...new Map((turn?.ids ?? []).map(id => citeOf(id)).filter((c): c is Citation => Boolean(c)).map(c => [c.raw, c])).values()]
    await check($, cs)
    const vs = await Promise.all(cs.map(async c => (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value))
    const ok = vs.filter(v => v?.status === 'ok').length
    return { text: `${ok} of ${cs.length} citations resolve with their value` }
  })

  // a card by its place in the last reply (/thimble-card 2), or by the citation of it
  on('command.run', { command: 'thimble-card' }, async ($, e) => {
    const arg = e.args.trim().replace(/^\[\[|\]\]$/g, '').replace(/^card:/, '')
    const listed = lastCards
    const id = /^\d+$/.test(arg) ? listed[Number(arg) - 1] : arg || listed[0]
    const card = id ? await loadCard($, id) : null
    if (!id || !card) return { text: listed.length ? `the last reply has ${listed.length} card${listed.length === 1 ? '' : 's'}: /thimble-card 1 to ${listed.length}` : 'the last reply has no card' }
    await openCardPane($, id, '')
    return { text: `opened "${clip(card.question, 80)}"` }
  })

  // the card pane: the card at the pane's width, and in script mode its script and last run

  // ---------------------------------------------------------------------------------------------- views

  on('command.run', { command: 'thimble-view' }, async ($, e) => {
    await paths($)
    const views = await listViews($, `${cwd}/${HOME}`)
    const arg = e.args.trim().toLowerCase()
    const v = views.find(x => x.slug === arg || x.name.toLowerCase() === arg) ?? (arg ? undefined : views[0])
    if (!v && (arg === 'files' || (!arg && !views.length))) return { text: await filesCommand($, '') }
    if (!v) return { text: views.length ? `views: files, ${views.map(x => x.name).join(', ')}` : 'no view in this folder yet: /thimble-files browses its files' }
    await openView($, v.slug)
    return { text: `opened ${v.name}` }
  })

  // the views pane: every proposal and view with its state; `build <name>` builds one, `<name>` shows it
  on('command.run', { command: 'thimble-views' }, async ($, e) => {
    await scanProposals($)
    const words = e.args.trim()
    const build = /^build\s+/i.test(words)
    const name = words.replace(/^build\s+/i, '').toLowerCase()
    const row = name ? [...pipes.values()].find(r => r.p.slug === name || r.p.name.toLowerCase() === name) : undefined
    if (name && !row) return { text: pipes.size ? `views proposed: ${[...pipes.values()].map(r => r.p.name).join(', ')}` : 'no view proposed in this folder yet' }
    if (build && row) {
      if (working.has(row.p.slug)) return { text: `${row.p.name} is building` }
      void startBuild($, row.p.slug)
    }
    if (row) await $.state.set({ plugin: 'thimble-cc-mod', key: 'viewPane' }, row.p.slug)
    await openPane($, 'views', 'Views')
    return { text: build && row ? `building ${row.p.name}` : viewsCount([...pipes.values()].map(r => stateWords(r.s, r.drawable).state)) }
  })

  // the wheel over a view scrolls its list or its detail, which the view draws itself
  on('ui.scroll', { component: 'Pane', requestId: PANEL }, async ($, e, next) => {
    if ((await read($, viewA)) !== 'view') return next(e)
    await paths($)
    await viewWheel($, `${cwd}/${HOME}`, e.by, e.pointer?.row)
    return {}
  })

  // ---------------------------------------------------------------------------------------------- reports (reports.tsx)

  // main's `report` tool starts a writer; it runs without asking, since it only starts the mod's own subagent
  on('tool.check', { tool: REPORT_TOOL }, async () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => reportTool(reportCtx($), e))
  on('ui.render', { component: 'ToolUse', props: { tool: REPORT_TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{reportToolLine(e.props.input)}</Text>
  })
  // its result is for main; the line above says what it did
  on('ui.render', { component: 'ToolResult', props: { tool: REPORT_TOOL } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // main's `report_highlight` tool: a subagent marks the passages of a report the analyst's words name
  on('tool.check', { tool: HIGHLIGHT_TOOL }, async () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: HIGHLIGHT_TOOL }, async ($, e) => highlightTool(reportCtx($), e))
  on('ui.render', { component: 'ToolUse', props: { tool: HIGHLIGHT_TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{highlightToolLine(e.props.input)}</Text>
  })
  on('ui.render', { component: 'ToolResult', props: { tool: HIGHLIGHT_TOOL } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('command.run', { command: 'thimble-report' }, async ($, e) => reportCommand(reportCtx($), e.args))
  on('command.run', { command: 'thimble-reports' }, async $ => reportsCommand(reportCtx($)))

  // ---------------------------------------------------------------------------------------------- the file browser

  on('command.run', { command: 'thimble-files' }, async ($, e) => ({ text: await filesCommand($, e.args) }))
  // ---------------------------------------------------------------------------------------------- the harness
  // harness.tsx: the label tool and the commands (the coverage check runs at main's turn.complete)
  on('tool.check', { tool: LABEL_TOOL }, async () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: LABEL_TOOL }, async ($, e) => labelTool(harnessCtx($), e as never))
  on('ui.render', { component: 'ToolUse', props: { tool: LABEL_TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const name = (e.props.input as { name?: unknown } | undefined)?.name
    const l = typeof name === 'string' ? (await $.state.get({ ...LABELS, id: labelSlugOf(name) })).value : undefined
    return <Text dimColor wrap="truncate-end">{labelToolLine(e.props.input, l)}</Text>
  })
  // its result is for main, but a refusal shows as the engine draws an error
  on('ui.render', { component: 'ToolResult', props: { tool: LABEL_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('command.run', { command: 'thimble-coverage' }, async ($, e) => coverageCommand(harnessCtx($), e.args))
  on('command.run', { command: 'thimble-orient' }, async ($, e) => orientCommand(harnessCtx($), e.args))
  on('command.run', { command: 'thimble-label' }, async ($, e) => labelCommand(harnessCtx($), e.args))
  // main's `orient` tool: the orientation /thimble-orient starts, with the same options; it only starts the mod's fork
  on('tool.check', { tool: ORIENT_TOOL }, async () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: ORIENT_TOOL }, async ($, e) => orientTool(harnessCtx($), e as never))
  on('ui.render', { component: 'ToolUse', props: { tool: ORIENT_TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{orientToolLine(e.props.input)}</Text>
  })
  on('ui.render', { component: 'ToolResult', props: { tool: ORIENT_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('command.run', { command: 'thimble-home' }, async $ => homeCommand($))
}

// ------------------------------------------------------------------------------------------------ the harness

const LABELS = { plugin: 'thimble-cc-mod', key: 'labels' } as const

function labelSlugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'label'
}

/** What the harness shares of this module (harness.tsx HarnessCtx): the reports' share and its own. */
function harnessCtx($: Dollar): HarnessCtx {
  return {
    ...reportCtx($),
    boxed: (argv, init) => boxRun($, argv, init),
    children: async ids => {
      const all = await $.agent.list().catch(() => [])
      const out = new Set(ids)
      for (let grew = true; grew; ) {
        grew = false
        for (const a of all) if (a.parentId && out.has(a.parentId) && !out.has(a.id)) grew = Boolean(out.add(a.id))
      }
      return [...out]
    },
    session: () => $.session.id().catch(() => ''),
    sleep: ms => $.clock.sleep(ms),
    complete: req => $.model.complete(req),
    labelModel: async () => (await $.env.get('THIMBLE_CC_MOD_LABEL_MODEL').catch(() => undefined)) || 'claude-opus-5-5',
    coverage: async () => (await $.state.get({ plugin: 'thimble-cc-mod', key: 'coverage' })).value ?? null,
    setCoverage: async c => {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'coverage' }, c)
    },
    label: async slug => (await $.state.get({ ...LABELS, id: slug })).value,
    setLabel: async l => {
      await $.state.set({ ...LABELS, id: l.slug }, l)
    },
    labelOpen: async () => (await $.state.get({ plugin: 'thimble-cc-mod', key: 'label' })).value ?? '',
    setLabelOpen: async slug => {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'label' }, slug)
    },
    openHarness: (view, title) => openPane($, view, title),
    openCard: id => openCardPane($, id, ''),
    cardsChanged: async ids => {
      for (const id of ids) {
        const prev = (await $.state.get({ ...RUNS, id })).value ?? { rev: 0 }
        await $.state.set({ ...RUNS, id }, { ...prev, rev: prev.rev + 1 })
        const mine = [...known.values()].filter(c => c.ref.startsWith(`card:${id}#`))
        if (mine.length) await check($, mine)
      }
    },
    thread: async about => {
      await openThread($, about)
    },
    submit: async text => {
      await $.prompt.submit({ text, asUser: true })
    },
    labelOpened: async () => (await $.state.get({ plugin: 'thimble-cc-mod', key: 'labelOpen' })).value ?? [],
    setLabelOpened: async open => {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'labelOpen' }, open)
    },
    toast: text => $.ui.toast(text),
    log: text => $.ui.log(text),
  }
}

// ------------------------------------------------------------------------------------------------ the home panel
//
// One panel of everything this folder holds of the mod's, laid out by home.ts and drawn by the Client homeview.tsx. It
// opens from the breadcrumb's first step ("home"), from the row above the prompt when several side threads hold new
// answers, and by /thimble-home. A click on an item opens it in its own panel after home on the breadcrumb, so back
// returns here. It stays live: it reads the state of what it lists (threads, their unread answers, reports, labels,
// views, the coverage count), so a change of any draws it again, and while it shows, the folder's cards, answers,
// threads, reports and labels are watched on disk (watchHome).

const HOME_UI = { plugin: 'thimble-cc-mod', key: 'homeUi' } as const
const homeTickA = atom({ plugin: 'thimble-cc-mod', key: 'homeTick' } as const, 0)
let homeWatch: { cancel: () => void } | null = null
let homeSig = '' // what watchHome last saw on disk
const answerHeads = new Map<string, { head: string; cards: string[] }>() // an answer file read once, by its name
// the reports written in this session the analyst has not opened yet: `new` after their names
const freshReports = new Set<string>()

async function homeUi($: Dollar): Promise<HomeUi> {
  const v = (await $.state.get(HOME_UI)).value
  if (!v) return HOME_UI_EMPTY
  return { ...HOME_UI_EMPTY, folded: v.folded ?? [], unfolded: v.unfolded ?? [], more: v.more ?? [], pick: v.pick ?? '' }
}

/** An answer file's time from its name (20261005-214730.md), as epoch ms. */
function answerTime(name: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : 0
}

/** What the home panel lists, read from the folder's files and this session's state. */
async function homeData($: Dollar): Promise<HomeData> {
  await paths($)
  const dir = `${cwd}/${HOME}`
  const names = async (sub: string, ext: string) => {
    try {
      return (await $.fs.list(`${dir}/${sub}`)).map(f => f.name.split('/').at(-1) ?? f.name).filter(n => n.endsWith(ext)).sort()
    } catch {
      return []
    }
  }
  const text = (path: string) => $.fs.read(path).catch(() => '')
  await read($, proposalsA) // drawn again when a view's state changes
  await read($, newsA) // when a side thread's answer comes or is read
  await read($, homeTickA) // and when what it lists changed on disk (watchHome)
  const views = [...pipes.values()].map(r => {
    const w = stateWords(r.s, r.drawable)
    return { slug: r.p.slug, name: r.p.name, state: w.state, words: w.words, files: r.p.claims, unit: r.p.unit, drawable: r.drawable, left: r.s?.left?.length ?? 0, at: r.s?.at ?? (Date.parse(r.p.ts) || 0), ...(freshViews.has(r.p.slug) && w.state === 'built' ? { fresh: true } : {}) }
  })
  const rctx = reportCtx($)
  const groups: HomeCardGroup[] = []
  const reports = []
  for (const r of await allReports(rctx)) {
    const md = r.state === 'ready' ? await text(`${cwd}/${r.file}`) : ''
    const cards = md ? reportCards(md) : []
    reports.push({ slug: r.slug, title: r.title, form: typeOf(r.form).name, state: r.state, cards: cards.length, tools: r.tools, at: r.created, ...(freshReports.has(r.slug) && r.state === 'ready' ? { fresh: true } : {}) })
    groups.push({ head: r.title, from: 'report', cards: cards.map(id => ({ id, kind: '', question: '' })), at: r.created })
  }
  const mine = new Set((await read($, threadListA)) ?? [])
  const threads = []
  for (const t of await allThreads($)) {
    const st = threadState(t)
    const at = activity(t)
    threads.push({ id: t.id, title: threadTitle(t), about: `about ${plainCites(t.label)}`, words: afterGlyph(st.words), tone: st.tone, unread: unread(t, (await $.state.get({ ...THREAD_SEEN, id: t.id })).value), earlier: !mine.has(t.id), at })
    groups.push({ head: threadTitle(t), from: 'thread', cards: embeddedCards(t.turns.map(x => x.a).join('\n\n')).map(id => ({ id, kind: '', question: '' })), at })
  }
  // an answer a task's notification started (a workflow's end) goes on with the question asked before it
  let lastHead = ''
  for (const name of await names('answers', '.md')) {
    let got = answerHeads.get(name)
    if (!got) {
      const md = await text(`${dir}/answers/${name}`)
      got = { head: (md.split('\n')[0] ?? '').replace(/^#\s*/, ''), cards: embeddedCards(md) }
      if (md) answerHeads.set(name, got)
    }
    const head = /^\s*<task-notification/.test(got.head) && lastHead ? lastHead : got.head
    if (!/^\s*</.test(head)) lastHead = head
    groups.push({ head, from: 'answer', cards: got.cards.map(id => ({ id, kind: '', question: '' })), at: answerTime(name) })
  }
  // every card of the folder, by its file: its kind and question
  const all: (HomeCard & { created: number })[] = []
  for (const name of await names('cards', '.json')) {
    const id = name.replace(/\.json$/, '')
    const c = await loadCard($, id)
    // the helper writes `created` as an ISO time
    const made = (c as { created?: unknown }).created
    if (c) all.push({ id, kind: c.kind, question: c.question, created: typeof made === 'number' ? made : Date.parse(String(made ?? '')) || 0 })
  }
  const byId = new Map(all.map(c => [c.id, c]))
  const known = groups.map(g => ({ ...g, cards: g.cards.flatMap(c => (byId.has(c.id) ? [byId.get(c.id)!] : [])) }))
  const cardGroups = groupCards(known, all.sort((a, b) => a.created - b.created))
  const labels = []
  try {
    const reg = JSON.parse(await text(`${dir}/labels.json`)) as { slug?: unknown; name?: unknown; kind?: unknown; scope?: unknown; counts?: unknown; labels?: unknown; paths?: unknown }[]
    for (const x of Array.isArray(reg) ? reg.slice().reverse() : []) {
      if (typeof x?.slug !== 'string') continue
      const l = (await $.state.get({ ...LABELS, id: x.slug })).value
      labels.push({ slug: x.slug, name: String(x.name ?? x.slug), kind: String(x.kind ?? ''), trial: x.scope === 'trial', counts: (x.counts ?? {}) as Record<string, number>, values: Array.isArray(x.labels) ? x.labels.map(String) : [], paths: Array.isArray(x.paths) ? x.paths.map(String) : [], running: l?.state === 'running' })
    }
  } catch {
    // no labels yet
  }
  // the summary as last read: reading it again runs a script longer than a drawing may take, so it runs after this
  // drawing, which the panel then draws again
  const cov = await harnessCtx($).coverage()
  const last = coverageLast()
  if (last.at !== (cov?.at ?? 0) || !last.data) homeCoverageLater($)
  return { views, reports, threads, cardGroups, labels, files: last.data?.files ?? [], coverage: last.data?.line ?? cov?.line ?? '', root: cwd.split('/').filter(Boolean).at(-1) ?? 'folder' }
}

let homeCovBusy = false

function homeCoverageLater($: Dollar): void {
  if (homeCovBusy) return
  homeCovBusy = true
  $.clock.after(0, () => {
    void (async () => {
      try {
        await coverageDetail(harnessCtx($))
      } finally {
        homeCovBusy = false
      }
      await update($, panelRedrawA, k => (k ?? 0) + 1)
    })()
  })
}

// the home panel's last layout, which a key steps through
let homeLast: HomeLayout | null = null

/** The home panel, drawn from home.ts's lines by homeview.tsx: a click on a row opens it, on a heading its section's
 *  panel, on a group or folder folds it; ↑↓ choose a row, Enter opens it and Space folds it. */
async function drawHome($: Dollar, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The home panel needs the terminal or the desktop app.</Text>
  const cols = Math.max(40, e.props.bodyColumns)
  const ui = await homeUi($)
  const lay = homeLayout(await homeData($), ui, cols)
  homeLast = lay
  const run = (act: HomeAct) => async () => {
    if (act.op === 'open') await homeOpen($, act.open)
    else await $.state.set(HOME_UI, homeReduce(await homeUi($), act))
  }
  const hits: LineHit[] = lay.hits.map(h => ({ y: h.y, x0: h.x0, x1: h.x1, row: h.row, run: async () => {
    if (h.pick) await $.state.set(HOME_UI, { ...(await homeUi($)), pick: h.pick })
    await run(h.act)()
  } }))
  const onKey = async (k: string) => {
    const cur = await homeUi($)
    const l = homeLast
    if (!l) return
    const pick = cur.pick || l.picks[0]?.key || ''
    const at = l.picks.find(p => p.key === pick)
    if (k === 'return' || k === 'enter') return at ? run(at.act)() : undefined
    if (k === 'space' || k === ' ') return at?.act.op === 'fold' ? run(at.act)() : undefined
    const next = homePick(l, cur, k)
    if (next !== cur.pick) await $.state.set(HOME_UI, { ...cur, pick: next })
  }
  return (
    <Box flexDirection="column">
      {hiddenKeys($, e, [{ key: 'close', hotkey: 'x', onPress: () => void closePanel($) }])}
      {linesEl($, e, marginKey('home'), lay.lines, hits, cols + MARGIN_W, onKey)}
    </Box>
  )
}

async function homeOpen($: Dollar, o: HomeOpen): Promise<void> {
  switch (o.kind) {
    case 'view':
      if (o.built) return openView($, o.slug)
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'viewPane' }, o.slug)
      return openPane($, 'views', 'Views')
    case 'report':
      return showReport(reportCtx($), o.slug)
    case 'thread': {
      const t = await threadOrSaved($, o.id)
      if (t) await showThread($, t)
      return
    }
    case 'card':
      return openCardPane($, o.id, '')
    case 'label':
      await labelsCommand(harnessCtx($), o.name)
      return
    case 'file':
      await filesCommand($, o.path)
      return
    case 'pane':
      return openPane($, o.view, o.title)
  }
}

/** /thimble-home: the panel. */
async function homeCommand($: Dollar): Promise<{ text: string }> {
  await coverageDetail(harnessCtx($)).catch(() => null)
  await openHome($)
  return { text: 'home' }
}

/** Open the home panel. */
async function openHome($: Dollar): Promise<void> {
  await scanProposals($)
  homeSig = await homeSignature($)
  await openPane($, 'home', 'Home')
}

/** What the home panel lists of the folder's files, in a word: each folder's count and newest change, and labels.json's
 *  size and time. */
async function homeSignature($: Dollar): Promise<string> {
  await paths($)
  const dir = `${cwd}/${HOME}`
  const parts: string[] = []
  for (const sub of ['cards', 'answers', 'threads', 'reports']) {
    const got = await $.fs.list(`${dir}/${sub}`).catch(() => [])
    parts.push(`${got.length}:${got.reduce((m, f) => Math.max(m, f.mtimeMs || 0), 0)}`)
  }
  const st = await $.fs.stat(`${dir}/labels.json`).catch(() => null)
  parts.push(st ? `${st.size}:${st.mtimeMs}` : '-')
  return parts.join('|')
}

const HOME_WATCH_MS = 1500

/** While the panel shows home, the folder's files it lists are looked at every HOME_WATCH_MS: a card, an answer, a
 *  thread, a report or a label written since draws it again. A card or answer file is written by a script or by a turn
 *  of main, not through the mod's state, so nothing else would. The watch ends once the panel shows something else. */
function watchHome($: Dollar): void {
  if (homeWatch) return
  const w = $.clock.every(HOME_WATCH_MS, () => {
    void (async () => {
      let shown = false
      try {
        shown = (await read($, viewA)) === 'home' && (await $.ui.panes()).some(p => p.id === PANEL && p.isPlaced)
      } catch {
        shown = false
      }
      if (!shown) {
        w.cancel()
        if (homeWatch === w) homeWatch = null
        return
      }
      const sig = await homeSignature($)
      if (sig === homeSig) return
      homeSig = sig
      await update($, homeTickA, k => (k ?? 0) + 1)
    })()
  })
  homeWatch = w
}

// ------------------------------------------------------------------------------------------------ views
//
// A view's files (.thimble-cc-mod/views/<slug>/view.json and rows.json, views/SPEC.md) laid out at the panel's size
// (viewdraw.ts) for the Client views.tsx; the acts and keys it posts change the view's state (in `views`, by slug).

type LoadedView = { slug: string; spec: ViewSpec | null; data: ViewData | null; problems: string[]; notes: string[] }
type ViewEffect = { ask?: { label: string; context: string; ref?: string }; open?: { ref: string; text: string }; file?: string; from?: number; up?: true }

const VIEWS = { plugin: 'thimble-cc-mod', key: 'views' } as const
const viewOpenA = atom({ plugin: 'thimble-cc-mod', key: 'view' } as const, '')
const loaded = new Map<string, { stamp: string; view: LoadedView }>()
const loading = new Map<string, { stamp: string; view: Promise<LoadedView> }>()
// one change of a view's state at a time: each act reads the state the one before it wrote, so keys typed while the
// view draws are each kept
const viewTurn = <T,>(slug: string, f: () => Promise<T>): Promise<T> => inTurn(`view:${slug}`, f)
const metas = new Map<string, ViewMeta>()
const viewHits = new Map<string, { stamp: string; hits: Hit[] }[]>()
const seenActs = new Map<string, number>()

async function viewMtime($: Dollar, file: string): Promise<number> {
  try {
    return Number(((await $.fs.stat(file)) as { mtimeMs?: number }).mtimeMs ?? 0)
  } catch {
    return -1
  }
}

/** A view's spec and rows, read again when either file changes; problems when they do not validate. `home` is the
 *  folder's .thimble-cc-mod. Every drawing and act asks for it; one read serves those that ask while it runs, and the
 *  rows a view held are let go before its new ones are read, so a view of tens of megabytes is held once, not twice
 *  or more, in the hooks worker. */
async function loadView($: Dollar, home: string, slug: string): Promise<LoadedView> {
  const dir = viewDir(home, slug)
  if (!SLUG_RE.test(slug.replace(/^@/, ''))) return { slug, spec: null, data: null, problems: [`no view ${slug}`], notes: [] }
  const stamp = `${await viewMtime($, `${dir}/view.json`)}:${await viewMtime($, `${dir}/rows.json`)}`
  const hit = loaded.get(slug)
  if (hit && hit.stamp === stamp) return hit.view
  const pending = loading.get(slug)
  if (pending && pending.stamp === stamp) return pending.view
  loaded.delete(slug)
  const view = readView($, dir, slug)
  loading.set(slug, { stamp, view })
  try {
    const v = await view
    if (loading.get(slug)?.view === view) loaded.set(slug, { stamp, view: v })
    return v
  } finally {
    if (loading.get(slug)?.view === view) loading.delete(slug)
  }
}

async function readView($: Dollar, dir: string, slug: string): Promise<LoadedView> {
  const view: LoadedView = { slug, spec: null, data: null, problems: [], notes: [] }
  const json = async (name: string): Promise<unknown> => {
    try {
      return JSON.parse(await $.fs.read(`${dir}/${name}`))
    } catch (err) {
      view.problems.push(`${name}: ${String(err).includes('JSON') ? 'not JSON' : 'cannot be read'}`)
      return null
    }
  }
  const spec = await json('view.json')
  const data = await json('rows.json')
  // rows.json in parts (helper/viewpipe.py write_rows), each read on its own: their rows put back in place
  const parts = (data as { parts?: unknown } | null)?.parts
  if (Array.isArray(parts)) {
    const cols = (data as ViewData).collections
    for (const part of parts) {
      const got = typeof part === 'string' && /^rows-\d+\.json$/.test(part) ? ((await json(part)) as ViewData | null) : null
      for (const [k, rows] of Object.entries(got?.collections ?? {})) {
        const into = (cols[k] ??= [])
        for (const r of rows) into.push(r)
      }
    }
    delete (data as { parts?: unknown }).parts
  }
  if (spec !== null) view.problems.push(...validateSpec(spec, { builtin: slug.startsWith('@') }).map(p => `view.json ${p}`))
  if (!view.problems.length) {
    const d = validateData(spec as ViewSpec, data)
    view.problems.push(...d.problems.map(p => `rows.json ${p}`))
    view.notes = d.notes
  }
  if (!view.problems.length) {
    view.spec = spec as ViewSpec
    view.data = data as ViewData
  }
  return view
}

/** The views of the folder, by slug, with their names. */
async function listViews($: Dollar, home: string): Promise<{ slug: string; name: string }[]> {
  let entries: { name: string; kind?: string }[] = []
  try {
    entries = (await $.fs.list(`${home}/views`)) as { name: string; kind?: string }[]
  } catch {
    return []
  }
  const out: { slug: string; name: string }[] = []
  for (const e of entries) {
    const slug = e.name.split('/').at(-1) ?? e.name
    if (!SLUG_RE.test(slug)) continue
    try {
      const spec = JSON.parse(await $.fs.read(`${home}/views/${slug}/view.json`)) as { name?: unknown }
      out.push({ slug, name: typeof spec.name === 'string' ? spec.name : slug })
    } catch {
      // a folder without its spec yet: a view still being built
    }
  }
  return out
}

async function viewState($: Dollar, slug: string): Promise<ViewState> {
  return ((await $.state.get({ ...VIEWS, id: slug })).value as ChatViewState | undefined) ?? initialState()
}

/** The open view in the panel, as wide and tall as the panel's type area. Claude Code's close mark and the `x` key close
 *  the panel; it draws no close row. */
async function drawViewPane($: Dollar, e: PaneEvent, home: string, close: () => void): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const slug = await read($, viewOpenA)
  const closeKey = hiddenKeys($, e, [{ key: 'close', hotkey: 'x', onPress: close }])
  if (!slug) return <Box flexDirection="column">{closeKey}<Text dimColor>none</Text></Box>
  const v = await loadView($, home, slug)
  if (!v.spec || !v.data) {
    return (
      <Box flexDirection="column">
        {closeKey}
        <Text>{slug}</Text>
        {v.problems.slice(0, 20).map(p => <Text color={COLORS.problem} wrap="truncate-end">{p}</Text>)}
      </Box>
    )
  }
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>A view needs the terminal or the desktop app.</Text>
  const { Client } = $.ui.resolve(e)
  const cols = Math.max(40, e.props.bodyColumns)
  const rows = Math.max(16, (e.props.scroll?.bodyRows || 40) - 1)
  const st = await viewState($, slug)
  // the view's lines bring the margin, where `❯` marks the selected row: they are the type area and 2 cells wider
  const lay = viewLayout(v.spec, v.data, st, cols, rows, VIEW_MARGIN, MARGIN_W)
  metas.set(slug, lay.meta)
  const packed = packHits(lay.hits)
  keepHits(slug, packed.stamp, lay.hits)
  const w = cols + MARGIN_W
  return (
    <Box flexDirection="column">
      {closeKey}
      <Client key={marginKey(`view:${slug}`)} module="./views.tsx" width={w} height={lay.lines.length} props={JSON.parse(JSON.stringify({ lines: lay.lines.map(mergeSegs), hits: packed.hits, stamp: packed.stamp, cols: w, view: slug })) as never} />
    </Box>
  )
}

/** Neighbouring segments of one style as one: fewer characters in the Client's props. */
function mergeSegs(l: Line): Line {
  const out: Line = []
  for (const sg of l) {
    const prev = out.at(-1)
    const same = prev && (['fg', 'bg', 'b', 'd', 'i', 'u', 'inv'] as const).every(k => (prev[k] ?? false) === (sg[k] ?? false))
    if (prev && same) out[out.length - 1] = { ...prev, s: prev.s + sg.s }
    else out.push(sg)
  }
  return out
}

/** The hits of each drawing the Client may still show, by its stamp, so a click maps to the act it was drawn with. */
function keepHits(slug: string, stamp: string, hits: Hit[]): void {
  const kept = (viewHits.get(slug) ?? []).filter(k => k.stamp !== stamp)
  viewHits.set(slug, [...kept, { stamp, hits }].slice(-6))
}

/** What a click on a hit asks for: the act it was drawn with, or the side thread about its row (its "?"). A
 *  right-click does what a click does. */
function hitAct(slug: string, a: HitAct): ViewAct | null {
  const h = viewHits.get(slug)?.find(k => k.stamp === a.s)?.hits[a.i]
  if (!h) return null
  const sel = a.ask ? hitSel(h) : null
  return sel ? { op: 'ask', ...sel } : h.act
}

/** A post of the Client (`type: 'view'`): each act not seen yet applied to the view's state, in order; a click on a
 *  hit by the act it was drawn with. */
async function viewMessage($: Dollar, home: string, d: { view?: unknown; vorigin?: unknown; acts?: unknown }): Promise<ViewEffect[]> {
  if (typeof d.view !== 'string' || typeof d.vorigin !== 'string' || !Array.isArray(d.acts)) return []
  const last = seenActs.get(d.vorigin) ?? 0
  const fresh = (d.acts as { seq: number; act: ViewAct | HitAct }[]).filter(a => typeof a?.seq === 'number' && a.seq > last && a.act)
  if (!fresh.length) return []
  seenActs.set(d.vorigin, Math.max(...fresh.map(a => a.seq)))
  const acts: ViewAct[] = []
  for (const { act: a } of fresh) {
    const r = a.op === 'hit' ? hitAct(d.view, a) : a
    if (r) acts.push(r)
  }
  return acts.length ? applyActs($, home, d.view, acts) : []
}

/** Acts applied to a view's state (from the Client, the wheel or a command), in the order they came; the effects for
 *  the mod to act on. */
function applyActs($: Dollar, home: string, slug: string, acts: ViewAct[]): Promise<ViewEffect[]> {
  return viewTurn(slug, () => applyNow($, home, slug, acts))
}

async function applyNow($: Dollar, home: string, slug: string, acts: ViewAct[]): Promise<ViewEffect[]> {
  const v = await loadView($, home, slug)
  if (!v.spec || !v.data) return []
  let st = await viewState($, slug)
  const out: ViewEffect[] = []
  for (const a of acts) {
    const r: { state: ViewState; effect?: Effect } = reduce(v.spec, v.data, st, a, metas.get(slug))
    st = r.state
    if (r.effect?.ask) {
      const about = rowContext(v.spec, v.data, slug, r.effect.ask)
      if (about) out.push({ ask: about })
    }
    if (r.effect?.open) out.push({ open: r.effect.open })
    if (r.effect?.file) out.push({ file: r.effect.file, ...(r.effect.from ? { from: r.effect.from } : {}) })
    if (r.effect?.up) out.push({ up: true })
  }
  await $.state.set({ ...VIEWS, id: slug }, st)
  return out
}

/** The wheel over the view: the detail scrolls when the pointer is over it, else the tab's list. */
async function viewWheel($: Dollar, home: string, by: number, row: number | undefined): Promise<void> {
  const slug = await read($, viewOpenA)
  const meta = slug ? metas.get(slug) : undefined
  if (!slug || !meta) return
  const inDetail = row !== undefined && row >= meta.detail[0] && row < meta.detail[1]
  await applyActs($, home, slug, [inDetail ? { op: 'dscroll', d: by } : { op: 'scroll', d: by }])
}

/** Open a view in the panel (.thimble-cc-mod/views/<slug>/): its spec and rows checked, its state kept, with `patch`
 *  over it (a tab, a row selected for a citation of the view's unit, a facet). */
async function openView($: Dollar, slug: string, patch: Partial<ViewState> = {}): Promise<void> {
  await markFresh($, slug, false)
  await paths($)
  if (Object.keys(patch).length) await viewTurn(slug, async () => $.state.set({ ...VIEWS, id: slug }, { ...(await viewState($, slug)), ...patch }))
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'view' }, slug)
  // the pane loads the view as it draws: a large rows.json read here could outlast a button's press
  const name = loaded.get(slug)?.view.spec?.name ?? pipes.get(slug)?.p.name ?? slug
  await openPane($, 'view', clip(name, 60))
}

/** What the view's acts ask of the mod: a side thread about a row, a place opened, a file. A record the view opens is
 *  named by its row in the panel, not as a citation. */
async function viewEffects($: Dollar, fx: ViewEffect[]): Promise<void> {
  for (const f of fx) {
    if (f.file) await openFile($, f.file, undefined, f.from)
    if (f.up) await openFiles($)
    if (f.ask) await openThread($, f.ask)
    if (f.open) {
      viewRecords.set(cid(`[[${f.open.ref}]]`), f.open.text)
      await openPlace($, { raw: `[[${f.open.ref}]]`, ref: f.open.ref, display: null })
    }
  }
}


// ------------------------------------------------------------------------------------------------ the view pipeline
//
// thimble's view pipeline for the terminal (views/SPEC.md, "The pipeline"). A proposal is a folder's proposal.json,
// written by main through helper/viewpipe.py (or by hand); a builder subagent ("view · building <name>") writes
// reader.py and view.json from prompt/view-build.md; helper/viewpipe.py's checks run when it ends, and their report goes
// to a new builder until they pass or BUILD_ATTEMPTS ran out; the view then opens in the panel, and a reviewer
// subagent ("view · reviewing <name>") reads it drawn as text (tools/render_view.mjs) and may send problems back to a
// builder, REVIEW_ROUNDS times at most. Each step's state is written to the view's status.json; the row above the
// prompt and the views pane (/thimble-views) show it.

type PipeRow = { p: Proposal; s: BuildStatus | undefined; drawable: boolean }
type AboveEvent = MatchedEvent<'ui.render', { component: 'AbovePrompt' }>

const pipes = new Map<string, PipeRow>() // every proposal of the folder, by slug
const working = new Set<string>() // the slugs whose builder, checks or reviewer run in this session
const proposalsA = atom({ plugin: 'thimble-cc-mod', key: 'viewProposals' } as const, [])
const viewPaneA = atom({ plugin: 'thimble-cc-mod', key: 'viewPane' } as const, '')
const templates = new Map<string, string>()

async function readJsonFile($: Dollar, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

async function template($: Dollar, name: string): Promise<string> {
  const hit = templates.get(name)
  if (hit !== undefined) return hit
  let t = ''
  try {
    t = await $.fs.read(`${root}/prompt/${name}.md`)
  } catch {
    t = ''
  }
  templates.set(name, t)
  return t
}

let scanChain: Promise<void> = Promise.resolve()

/** Read every proposal of the folder again; start the build of one that asks for it and was not built as it stands.
 *  One read at a time, so two calls close together start one build. */
function scanProposals($: Dollar): Promise<void> {
  scanChain = scanChain.then(() => scanOnce($)).catch(() => undefined)
  return scanChain
}

async function scanOnce($: Dollar): Promise<void> {
  await paths($)
  const home = `${cwd}/${HOME}/views`
  let entries: { name: string }[] = []
  try {
    entries = await $.fs.list(home)
  } catch {
    entries = []
  }
  for (const ent of entries) {
    const slug = ent.name.split('/').at(-1) ?? ent.name
    if (!SLUG_RE.test(slug)) continue
    const p = parseProposal(await readJsonFile($, `${home}/${slug}/proposal.json`))
    if (!p || p.slug !== slug) continue
    const drawable = (await $.fs.exists(`${home}/${slug}/view.json`)) && (await $.fs.exists(`${home}/${slug}/rows.json`))
    const saved = (await readJsonFile($, `${home}/${slug}/status.json`)) as BuildStatus | undefined
    const mem = pipes.get(slug)
    let s = mem?.s ?? saved
    // a step left active by this session before the hooks reloaded goes on while its subagent runs; one an earlier
    // session left stopped with it
    if (s && ACTIVE.includes(s.state) && !working.has(slug)) {
      const alive = s.agent ? (await $.agent.list().catch(() => [])).some(x => x.id === s!.agent && (x.status === 'running' || x.status === 'pending')) : false
      if (alive) working.add(slug)
      else s = { ...s, state: 'stopped', step: '', agent: '' }
    }
    if (mem) Object.assign(mem, { p, s, drawable })
    else {
      pipes.set(slug, { p, s, drawable })
      // a proposal made in this session gets its `↳ view` row in main's chat
      if ((Date.parse(p.ts) || 0) >= sessionAt - 5000) await attachViewRow($, slug)
    }
    // a build asked for in main's turn starts when the turn ends, which reads the proposals again
    if (p.build && (!s || s.for !== p.ts) && !working.has(slug) && !mainBusy) void startBuild($, slug)
  }
  await refreshRow($)
}

/** The row above the prompt's entries, as state, so the row draws again when one changes. */
async function refreshRow($: Dollar): Promise<void> {
  const rows: ChatViewPipeRow[] = [...pipes.values()].map(r => {
    const w = stateWords(r.s, r.drawable)
    return { slug: r.p.slug, name: r.p.name, mark: w.mark, words: w.words, state: w.state, drawable: r.drawable }
  })
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'viewProposals' }, rows)
}

/** A step of a build: merged into its status, written to status.json (but a step's words, which change often). */
async function setStatus($: Dollar, slug: string, patch: Partial<BuildStatus>, write = true): Promise<void> {
  const row = pipes.get(slug)
  if (!row) return
  const s: BuildStatus = { for: row.p.ts, state: 'building', attempt: 1, round: 0, ...row.s, ...patch, at: await $.clock.now() }
  row.s = s
  if (write) {
    await paths($)
    const { step: _step, ...kept } = s
    await $.fs.write(`${cwd}/${HOME}/views/${slug}/status.json`, JSON.stringify(kept, null, 1)).catch(() => undefined)
  }
  await refreshRow($)
}

/** The builder's prompt: prompt/view-build.md for the proposal, then the checks' report, the review's problems, or the
 *  change the analyst asked for (prompt/view-change.md) when this builder follows another. */
async function builderPrompt($: Dollar, p: Proposal, follow: { gates?: string[]; review?: string[]; change?: string }): Promise<string> {
  await paths($)
  const folder = `${cwd}/${HOME}/views/${p.slug}`
  const checkCmd = `python3 ${root}/helper/viewpipe.py check ${p.slug}`
  const render = `node ${root}/tools/render_view.mjs --spec ${folder}/view.json --rows ${folder}/rows.json --all --plain --width 96 --height 48`
  const own: Record<string, boolean> = {}
  const rowsOp: Record<string, boolean> = {}
  for (const name of ['timeline', 'linked-sessions', 'repository']) {
    const spec = (await readJsonFile($, `${root}/viewers/${name}/view.json`)) as { collections?: unknown } | undefined
    own[name] = Array.isArray(spec?.collections)
    let reader = ''
    try {
      reader = await $.fs.read(`${root}/viewers/${name}/reader.py`)
    } catch {
      reader = ''
    }
    rowsOp[name] = /==\s*["']rows["']/.test(reader)
  }
  const first = buildPrompt(await template($, 'view-build'), p, {
    corpus: cwd,
    folder,
    specMd: `${root}/views/SPEC.md`,
    examples: examplesText(`${root}/viewers`, `${root}/tests/fixtures/views`, own, rowsOp),
    check: checkCmd,
    render,
    draft: !follow.gates && !follow.review && !follow.change && (await $.fs.exists(`${folder}/view.json`)),
  })
  if (follow.change) return `${first}\n\n${fill(await template($, 'view-change'), { folder, request: follow.change, check: checkCmd })}`
  if (follow.review) return `${first}\n\n${fill(await template($, 'view-revise'), { folder, drawings: `${folder}/render.txt`, findings: findingsText(follow.review), check: checkCmd })}`
  if (follow.gates) return `${first}\n\n${fill(await template($, 'view-gates'), { folder, check: checkCmd, report: ['```', ...follow.gates, '```'].join('\n') })}`
  return first
}

/** Start a builder for the proposal: the first, one after checks that failed (`gates`, their lines), one that fixes
 *  what the review found (`review`), or one that makes the change the analyst asked for (`change`). */
async function startBuild($: Dollar, slug: string, follow: { gates?: string[]; review?: string[]; change?: string } = {}): Promise<void> {
  const row = pipes.get(slug)
  if (!row) return
  working.add(slug)
  if (mainBusy) {
    afterMain.push(() => startBuild($, slug, follow))
    return
  }
  await setStatus($, slug, buildStart(row.s, row.p.ts, follow))
  const prompt = await builderPrompt($, row.p, follow)
  const label = buildName(row.p.name)
  const r = await spawnSub($, prompt, label, prompt)
  if ('deny' in r) {
    working.delete(slug)
    await setStatus($, slug, { state: 'failed', error: `could not start a subagent: ${clip(r.deny, 120)}` })
    return
  }
  await setStatus($, slug, { agent: r.agentId })
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'view-build', label, view: slug })
}

/** helper/viewpipe.py's checks of a view, run by the mod (never the builder's copy of their output). */
async function runViewChecks($: Dollar, slug: string): Promise<{ ok: boolean; lines: string[] }> {
  await paths($)
  try {
    const r = await boxRun($, ['python3', `${root}/helper/viewpipe.py`, 'check', slug, '--root', cwd], { cwd, timeoutMs: 600000 })
    const lines = r.stdout.trim().split('\n').filter(Boolean)
    return { ok: r.exitCode === 0, lines: lines.length ? lines : [`problem: ${clip(r.stderr.trim() || 'the checks printed nothing', 600)}`] }
  } catch (err) {
    return { ok: false, lines: [`problem: the checks did not run: ${clip(String(err), 300)}`] }
  }
}

/** A builder ended: the checks run, and afterBuild says what follows (the review, a builder given their report, the
 *  view put back as reviewed, or a failure); a first build that passes opens in the panel and main is told. */
async function buildComplete($: Dollar, agentId: string, a: ChatAgent, reason: string): Promise<void> {
  const slug = a.view ?? ''
  const row = pipes.get(slug)
  if (!row || row.s?.agent !== agentId || row.s.state === 'stopped') return
  await setStatus($, slug, { state: 'checking', step: '', agent: '' })
  const rep = await runViewChecks($, slug)
  const step = afterBuild(row.s!, rep.ok, rep.lines, reason)
  if (rep.ok) row.drawable = true
  await setStatus($, slug, step.patch)
  if (rep.ok) await viewChanged($, slug)
  if (step.open) {
    await showBuilt($, slug)
    await noteMain($, `thimble-cc-mod: the view ${row.p.name} is built in ${HOME}/views/${slug}/ (reader.py, view.json, rows.json), passed its checks and shows in the panel, but it is not ready: a reviewer reads it next and may send it back to a builder.`)
  }
  if (step.next === 'review') return startReview($, slug)
  if (step.next === 'gates') return startBuild($, slug, { gates: rep.lines })
  working.delete(slug)
  if (step.next === 'restore') {
    await copyReviewed($, slug, 'restore')
    await noteMain($, viewReadyNote(row.p, HOME, 0, 'The fixes its last review asked for never passed the checks, so it is the view as that review found it.'))
  }
  if (step.next === 'failed') await noteMain($, `thimble-cc-mod: the build of the view ${row.p.name} failed: ${step.patch.error ?? 'its checks did not pass'}. The views pane (/thimble-views) can build it again.`)
}

/** The built view in the panel, unless the panel shows something else the analyst opened. */
async function showBuilt($: Dollar, slug: string): Promise<void> {
  await markFresh($, slug, true)
  const shown = (await $.ui.panes().catch(() => [])).some(p => p.id === PANEL)
  const what = await read($, viewA)
  if (!shown || what === 'views' || (what === 'view' && (await read($, viewOpenA)) === slug)) await openView($, slug)
}

/** A view's files changed under the panel: it draws again when it shows the view. */
async function viewChanged($: Dollar, slug: string): Promise<void> {
  if ((await read($, viewA)) === 'view' && (await read($, viewOpenA)) === slug) await viewTurn(slug, async () => $.state.set({ ...VIEWS, id: slug }, { ...(await viewState($, slug)) }))
}

/** The view as the review found it, kept in reviewed/ before a builder fixes it (`keep`), and put back when the fixes
 *  never pass the checks (`restore`), by the helper, which copies rows.json's parts too. It runs in the scripts'
 *  sandbox, since a script can replace the folders it copies between with links out of the folder. */
async function copyReviewed($: Dollar, slug: string, op: 'keep' | 'restore'): Promise<void> {
  await boxRun($, ['python3', `${root}/helper/viewpipe.py`, op, slug, '--root', cwd], { cwd, timeoutMs: 120000 }).catch(() => undefined)
  if (op === 'restore') await viewChanged($, slug)
}

/** The view drawn as the reviewer reads it: every tab as it opens and with its first row selected, 96 columns wide,
 *  then the first tab 66 wide; saved as render.txt beside the view. Drawn in the scripts' sandbox, as the checks draw
 *  it, since a script can replace the files it reads with links out of the folder. */
async function drawingsOf($: Dollar, slug: string): Promise<string> {
  const dir = `${cwd}/${HOME}/views/${slug}`
  const base = ['node', `${root}/tools/render_view.mjs`, '--spec', `${dir}/view.json`, '--rows', `${dir}/rows.json`, '--plain', '--height', '48']
  const run = async (more: string[]) => {
    try {
      const r = await boxRun($, [...base, ...more], { cwd, timeoutMs: 120000 })
      return r.exitCode === 0 ? r.stdout : `(the drawing failed: ${clip(r.stderr, 300)})`
    } catch (err) {
      return `(the drawing failed: ${clip(String(err), 300)})`
    }
  }
  const spec = (await readJsonFile($, `${dir}/view.json`)) as { tabs?: { name?: string }[] } | undefined
  const text = `${(await run(['--all', '--width', '96'])).trimEnd()}\n\n=== ${spec?.tabs?.[0]?.name ?? 'the first tab'}, 66 columns wide\n${(await run(['--tab', '0', '--width', '66'])).trimEnd()}\n`
  await $.fs.write(`${dir}/render.txt`, text).catch(() => undefined)
  return text
}

/** The reviewer: it reads the drawn view and answers with the problems it sees (prompt/view-review.md). */
async function startReview($: Dollar, slug: string): Promise<void> {
  const row = pipes.get(slug)
  if (!row) return
  if (mainBusy) {
    afterMain.push(() => startReview($, slug))
    return
  }
  await setStatus($, slug, { state: 'reviewing', step: '' })
  const dir = `${cwd}/${HOME}/views/${slug}`
  const drawings = await drawingsOf($, slug)
  const prompt = fill(await template($, 'view-review'), {
    name: row.p.name,
    folder: dir,
    why: row.p.why,
    claims: row.p.claims.join(', '),
    spec: proposalBullets(row.p),
    checks: (row.s?.checks ?? []).filter(l => !/^(ok |checks passed)/.test(l)).join('\n') || '(nothing to note)',
    drawings: drawings.length > 60000 ? `${drawings.slice(0, 60000)}\n(the rest is in render.txt)` : drawings,
    rows: `${dir}/rows.json`,
    render: `node ${root}/tools/render_view.mjs --spec ${dir}/view.json --rows ${dir}/rows.json --plain --width 96 --height 48`,
    last: lastLook(row.s),
  })
  const label = reviewName(row.p.name)
  const r = await spawnSub($, prompt, label, prompt)
  if ('deny' in r) {
    working.delete(slug)
    return setStatus($, slug, { state: 'built', step: '', error: `the review could not start: ${clip(r.deny, 120)}` })
  }
  await setStatus($, slug, { agent: r.agentId })
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'view-review', label, view: slug })
}

/** The reviewer answered: afterReview says whether the view is done or a builder fixes what it found. */
async function reviewComplete($: Dollar, agentId: string, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const slug = a.view ?? ''
  const row = pipes.get(slug)
  if (!row || row.s?.agent !== agentId || row.s.state === 'stopped') return
  await setStatus($, slug, { agent: '' })
  const problems = parseFindings(answer)
  const step = afterReview(row.s!, problems, reason)
  if (step.next === 'done') {
    working.delete(slug)
    await setStatus($, slug, step.patch)
    return noteMain($, viewReadyNote(row.p, HOME, step.patch.left?.length ?? 0, step.patch.error ? `Its review did not finish: ${step.patch.error}.` : ''))
  }
  await copyReviewed($, slug, 'keep')
  await startBuild($, slug, { review: problems ?? [] })
}

/** Stop a build: its builder or reviewer stops, and the view stays as its last checks left it. */
async function stopBuild($: Dollar, slug: string): Promise<void> {
  const id = pipes.get(slug)?.s?.agent
  working.delete(slug)
  await setStatus($, slug, { state: 'stopped', step: '', agent: '' })
  if (id) await endSub($, id, 'the analyst stopped the build')
}

/** A view's builder or reviewer by its agent id, as its status names it: what the mod's record of its subagents says
 *  of it, where that record is gone. */
function viewAgentOf(agentId: string): ChatAgent | undefined {
  for (const r of pipes.values()) {
    if (r.s?.agent !== agentId) continue
    const review = r.s.state === 'reviewing'
    return { kind: review ? 'view-review' : 'view-build', label: review ? reviewName(r.p.name) : buildName(r.p.name), view: r.p.slug }
  }
  return undefined
}

/** A builder's tool call, as the few words of its step (a step's words are not written to status.json). */
async function pipeStep($: Dollar, agentId: string, content: unknown): Promise<void> {
  const a = (await agentOf($, agentId)) ?? viewAgentOf(agentId)
  if (a?.kind !== 'view-build' || !a.view || !Array.isArray(content)) return
  const use = (content as { type?: string; name?: string; input?: Record<string, unknown> }[]).filter(b => b?.type === 'tool_use').at(-1)
  const step = use ? stepOf(String(use.name ?? ''), use.input) : ''
  if (step && pipes.get(a.view)?.s?.step !== step) await setStatus($, a.view, { step }, false)
}

/** The columns of the row above the prompt that offers a panel a click held: a label dim at column 2, its words at 12. */
const ABOVE_LABEL = 12

/** A view's state words where its glyph already says what the words would: without "built", "proposed" or "failed". */
function afterMark(words: string): string {
  return words.replace(/^(built|proposed)(\s·\s|$)/, '').replace(/^failed:\s*/, '')
}

/** A view's state glyph as the rows and panes draw it: ● text, ◌ text, ○ dim, ! and × red. */
function viewGlyph(mark: string): { s: string; colour?: string; dim?: boolean } {
  return mark === '!' || mark === '×' ? { s: mark, colour: COLORS.problem } : mark === '○' ? { s: mark, dim: true } : { s: mark }
}

// the views built the analyst has not opened yet: `new` in green after their names until opened; kept in signals.json,
// so a reload of the hooks or a resume keeps them
const freshViews = new Set<string>()

async function markFresh($: Dollar, slug: string, on: boolean): Promise<void> {
  if (freshViews.has(slug) === on) return
  if (on) freshViews.add(slug)
  else freshViews.delete(slug)
  signals.fresh = [...freshViews]
  await saveSignals($)
}
// the views main proposed in its turn, whose `↳ view` row stands under the answer once the turn ends
let viewRowsPending: string[] = []

/** Whether a view already has its `↳ view` row under some row of main's chat. */
function viewRowKnown(slug: string): boolean {
  return Object.values(signals.views).some(xs => xs.includes(slug)) || viewRowsPending.includes(slug)
}

/** A view main (or an orientation) proposed gets one `↳ view` row in main's chat: under the answer of the turn that
 *  proposed it (`anchor`, its last row, once the turn ends), else under main's latest row. */
async function attachViewRow($: Dollar, slug: string, anchor?: string): Promise<void> {
  if (!anchor && viewRowKnown(slug)) return
  if (!anchor && mainBusy) {
    viewRowsPending.push(slug)
    return
  }
  const at = anchor || signals.last || WAITING
  const rows = [...(signals.views[at] ?? []).filter(x => x !== slug), slug]
  signals.views[at] = rows
  await $.state.set({ ...VIEW_ROWS, id: at }, rows)
  await saveSignals($)
}

/** The views main proposed in the turn that just ended: their rows under its answer's last row. */
async function attachPendingViews($: Dollar, row: string): Promise<void> {
  const pending = viewRowsPending
  viewRowsPending = []
  for (const slug of pending) await attachViewRow($, slug, row || signals.last || WAITING)
}

/** The views pane (views/SPEC.md, section 7, "The views pane"): its title with `files ›` against R and a dim subtitle;
 *  under the rule, one row per view (its glyph, its name, its status dim at R), `❯` and the accent on the one chosen;
 *  under the second rule, the chosen view's description (the proposal's `why`) as prose, then `open` (`build` for a
 *  proposal, `stop` while it builds) and the field `ask for a change`, whose words go to the view's builder. */
async function drawPipePane($: Dollar, e: PaneEvent): Promise<RenderElement> {
  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>The views pane needs a surface with text fields.</Text>
  }
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const els = { Box, Text, Button }
  const cols = Math.max(40, e.props.bodyColumns)
  await read($, proposalsA) // drawn again whenever a proposal's state changes
  const all = [...pipes.values()]
  const chosen = pipes.get(await read($, viewPaneA)) ?? all[0]
  const pick = async (slug: string) => {
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'viewPane' }, slug)
  }
  const keys: { key: string; hotkey: string; onPress: () => void }[] = [{ key: 'files', hotkey: 'f', onPress: () => void openFiles($) }]
  const built = all.filter(r => stateWords(r.s, r.drawable).state === 'built').length
  const out: RenderElement[] = [
    ...headerEls(els, { title: 'Views', cols, right: <Button key="vfiles" label="files ›" plain onPress={() => void openFiles($)} />, sub: subLine([`${all.length} view${all.length === 1 ? '' : 's'}`, built ? `${built} built` : '']) }),
  ]
  const lines: Line[] = []
  const hits: LineHit[] = []
  all.forEach((r, i) => {
    const w = stateWords(r.s, r.drawable)
    const g = viewGlyph(w.mark)
    const fresh = freshViews.has(r.p.slug) && w.state === 'built'
    const rest = afterMark(w.words)
    const right: Line = [...(rest ? [{ s: rest, fg: w.state === 'failed' ? COLORS.problem : COLORS.dim }] : []), ...(fresh ? [...(rest ? [{ s: '  ' }] : []), freshSeg()] : [])]
    const y = lines.length
    lines.push(pointed(spread([{ s: g.s, ...(g.colour ? { fg: g.colour } : g.dim ? { fg: COLORS.dim } : {}) }, { s: ' ' }, { s: r.p.name }], right, cols), r === chosen))
    hits.push({ y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => pick(r.p.slug) })
    if (i < 9) keys.push({ key: `v${i}`, hotkey: String(i + 1), onPress: () => void pick(r.p.slug) })
  })
  if (!all.length) lines.push(pointed([{ s: '  ' }, { s: 'none', fg: COLORS.dim }], false))
  const step = async (d: number) => {
    if (!all.length) return
    const at = chosen ? all.indexOf(chosen) : -1
    await pick(all[Math.max(0, Math.min(all.length - 1, at + d))]!.p.slug)
  }
  const openChosen = async () => {
    if (chosen?.drawable) await openView($, chosen.p.slug)
  }
  out.push(linesEl($, e, marginKey('views-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : k === 'return' || k === 'enter' ? openChosen() : undefined)))
  // each view a press away by its key too, for a surface that draws no Client: no row of its own
  out.unshift(
    <Box key="view-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {all.map(r => <Button key={`vpick:${r.p.slug}`} label={r.p.name} plain onPress={() => void pick(r.p.slug)} />)}
    </Box>,
  )
  const hints = ['↑↓ to choose']
  if (chosen) {
    const p = chosen.p
    const w = stateWords(chosen.s, chosen.drawable)
    const busy = working.has(p.slug)
    out.push(ruleEl(els, cols, 'vrule2'))
    // why it was proposed, as prose filling the type area
    out.push(<Text key="vwhy" wrap="wrap">{p.why}</Text>)
    // where its build stands, while it builds or when it failed
    if (busy && chosen.s?.step) out.push(<Text key="vstep" dimColor wrap="truncate-end">{`◌ ${chosen.s.step}`}</Text>)
    if (w.state === 'failed' && chosen.s?.error) out.push(<Text key="verr" color={COLORS.problem} wrap="wrap">{`× ${chosen.s.error}`}</Text>)
    const controls = [
      chosen.drawable ? <Button key="vopen" label="open" plain onPress={() => void openView($, p.slug)} /> : null,
      !busy && !chosen.drawable ? <Button key="vbuild" label="build" plain onPress={() => void startBuild($, p.slug)} /> : null,
      busy ? <Button key="vstop" label="stop" plain onPress={() => void stopBuild($, p.slug)} /> : null,
    ]
    if (chosen.drawable) {
      keys.push({ key: 'open', hotkey: 'o', onPress: () => void openView($, p.slug) })
      hints.push('Enter or o to open')
    }
    if (!busy && !chosen.drawable) {
      keys.push({ key: 'build', hotkey: 'b', onPress: () => void startBuild($, p.slug) })
      hints.push('b to build')
    }
    // a change asked for in the analyst's words goes to a builder, which changes the view's files (prompt/view-change.md)
    const field = chosen.drawable && !busy ? (
      <Box key="vchange" flexDirection="row">
        <Text dimColor>{'ask for a change  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Input key={`vchange-${p.slug}`} submitLabel="send" onSubmit={v => void (v.trim() ? startBuild($, p.slug, { change: v.trim() }) : undefined)} />
        </Box>
      </Box>
    ) : null
    // the description and the actions share the second rule (a panel has two at most), a blank row between them
    if (controls.some(Boolean) || field) out.push(<Text key="vgap"> </Text>)
    out.push(...bottomRows($, e, cols, controls, [field], [...hints, 'f for the files', 'x to close'], false))
  } else out.push(hintsEl(els, ['f for the files', 'x to close'], cols))
  keys.push({ key: 'close', hotkey: 'x', onPress: () => void closePanel($) })
  const hk = hiddenKeys($, e, keys)
  if (hk) out.unshift(hk)
  return <Box flexDirection="column">{out}</Box>
}

// ------------------------------------------------------------------------------------------------ the file browser
//
// /thimble-files: the folder's files as a tree, and one file opened in the modes its kind offers (Transcript, Table,
// Raw), as views the mod writes itself (helper/files.py) under .thimble-cc-mod/files/ and draws as it draws any view:
// search, sorts, filters, label marks, a record's place and "?" side threads come with it. Their slugs start with "@"
// (FILES_TREE, `@file-<hash>`), so they never mix with the views the pipeline builds.

/** The folder of a view's files: the pipeline's under views/, the file browser's under files/. */
function viewDir(home: string, slug: string): string {
  return slug.startsWith('@') ? `${home}/files/${slug.slice(1)}` : `${home}/views/${slug}`
}

type FilesAnswer = { ok: boolean; slug?: string; name?: string; error?: string }

/** helper/files.py's answer, or why it gave none. */
async function filesHelper($: Dollar, args: string[]): Promise<FilesAnswer> {
  await paths($)
  try {
    const r = await boxRun($, ['python3', `${root}/helper/files.py`, ...args, '--root', cwd], { cwd, timeoutMs: 180000 })
    const last = String(r.stdout ?? '').trim().split('\n').at(-1) ?? ''
    try {
      return JSON.parse(last) as FilesAnswer
    } catch {
      return { ok: false, error: clip(String(r.stderr || last || 'helper/files.py gave no answer').trim(), 300) }
    }
  } catch (err) {
    return { ok: false, error: clip(String(err), 300) }
  }
}

/** The tree of the folder's files, in the panel, read again each time it opens. */
async function openFiles($: Dollar): Promise<string> {
  const got = await filesHelper($, ['tree'])
  if (!got.ok) {
    $.ui.toast(`files: ${got.error ?? 'could not list the files'}`)
    return `could not list the files: ${got.error ?? ''}`
  }
  await paths($)
  await loadView($, `${cwd}/${HOME}`, FILES_TREE)
  await openView($, FILES_TREE)
  return 'opened the files'
}

/** A file of the folder in the file browser, at a record when one is given (a line, or a JSON list's item counted
 *  from 1): the window of the file that holds it, the record selected in the first tab that shows it; or the window
 *  that starts at `from`. A window's view is written again only when the file or the labels changed. */
async function openFile($: Dollar, path: string, at?: number, from?: number): Promise<string> {
  const name = path.split('/').at(-1) ?? path
  $.ui.status(`reading ${clip(name, 40)} …`)
  const where = at !== undefined ? ['--at', String(at)] : from !== undefined ? ['--from', String(from)] : []
  const got = await filesHelper($, ['open', path, ...where]).finally(() => $.ui.status(undefined))
  if (!got.ok || !got.slug) {
    $.ui.toast(`files: ${got.error ?? `could not open ${name}`}`)
    return `could not open ${path}: ${got.error ?? ''}`
  }
  const slug = `@${got.slug}`
  // read here, not first as the panel draws, so the panel is titled by the file and the record can be found
  const v = await loadView($, `${cwd}/${HOME}`, slug)
  const patch = (at !== undefined && v.spec && v.data && recordState(v.spec, v.data, at)) || {}
  await openView($, slug, patch)
  return `opened ${path}${at !== undefined ? ` at ${at}` : ''}`
}

/** The file a citation or a record cites, at its record. */
async function openRef($: Dollar, ref: string): Promise<string> {
  const f = fileRef(ref)
  if (!f) return `${ref} names no file of this folder`
  return openFile($, f.path, f.line ?? f.item)
}

/** /thimble-files: the tree; `<path>`, `<path>:<line>` or a ref (`<path>#L<n>`) opens a file. */
async function filesCommand($: Dollar, args: string): Promise<string> {
  const a = args.trim()
  if (!a) return openFiles($)
  const m = /^(.*?):(\d+)$/.exec(a)
  return m ? openFile($, m[1]!, Number(m[2])) : openRef($, a)
}

/** "in files" under a citation of a file: its record in the file browser; none when the way back already leads to
 *  that file's view. */
async function filesButton($: Dollar, e: PaneEvent, ref: string): Promise<RenderElement | null> {
  const f = fileRef(ref)
  if (!f) return null
  const prev = ((await read($, navA)) ?? NAV_EMPTY).trail.at(-2)
  const from = prev?.view === 'view' && prev.slug ? loaded.get(prev.slug)?.view.spec?.source : undefined
  if (from === f.path) return null
  const { Button } = $.ui.resolve(e)
  return <Button key="in-files" label="in files" plain onPress={() => void openRef($, ref)} />
}

