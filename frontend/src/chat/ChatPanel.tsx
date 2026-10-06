// The chat column: the thread tree at the top, the transcript of the thread being read, and the composer floating over
// it. Main is the analyst's Claude Code session and leaves out what shows elsewhere (model.mainSkips). A thread is a
// fork of main: main's conversation up to where it branched, then its own rows. The orientation and a writer show their
// card, then their whole session; a dev ticket shows its request and run; a view build its proposal and runs. While a
// thread works, a strip of its steps rides behind the composer, and every permission request waits on one card above
// it (PermissionCard). The composer sends where threads.composerTarget says, and while the agent a thread shows (or a
// step's parent) runs and the browser can stop it, the composer's send square is its Stop (composerStopOf). A thread
// whose run ended without a reply offers Ask again. Until an orientation was asked for, main's composer is the Start
// gate (StartGate); a start that did not happen shows its card in main (OrientStart) and the gate comes back filled in.
// While main runs outside thimble's fence, a banner says so (UnfencedBanner).
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { UserMessage } from '../components/Message'
import { RefChip } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { ThreadTree } from '../components/ThreadTree'
import { useTooltip } from '../components/Tooltip'
import { StepGlyph, type StepState, type ToolStep } from '../components/ToolCard'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { fetchCall } from '../lib/calls'
import { newest, STALE } from '../lib/newest'
import { callRef, parseRef } from '../lib/refs'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { ChatMeta, ChatRecord, MainEffort, ModelConf, Proposal, SessionAlert, StartAnswer, Ticket } from '../lib/types'
import { loadSettings, onSettingsChange } from '../lib/models'
import { findProposal, refreshProposals, useProposals } from '../lib/proposals'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { Composer } from './Composer'
import { mainEffort, mainFast, NEXT_LAUNCH } from './ModelLine'
import { API_ERROR_KIND, apiRetry, branchIndex, capacityNote, foldRecords, landedTexts, madeBy, mainSkips, orientRuns, orientSummaries, orientWriters, QUIET_RE, sessionSteps, stepEnded, toolSteps, withApiErrors, withBranches, withCallNumbers, type MainContext, type Row, type ShotRow } from './model'
import { Holds, useRetryText } from './Holds'
import { TicketStatus, useTicket } from './TicketStatus'
import { Divider, Note, ThreadChip, ThreadsContext } from './Notes'
import { RefText } from './markdown'
import { CallFocusContext, MAIN_RETRY_NOTE, Rows, THREAD_RETRY_NOTE, type CallFocus, type ErrorRetry } from './Rows'
import { countMessages, isUnread, markSeen, readSeen, type SeenMap } from './seen'
import { SKIPPED_NOTE, StartGate, restoreOf, startGateShown, startedChat } from './StartGate'
import { AgentCard, stopSession, useAgentRows } from './AgentCard'
import { OrientStart, useOrientRun } from './OrientStart'
import { CONTINUE_HERE_LINE, PAUSED_LINE, STOPPED_CONTINUE_LINE, continueOf, continueText, lastSession } from './subagent'
import { UnfencedBanner } from '../shell/UnfencedBanner'
import { ViewChip } from './ViewChip'
import { replayHeld } from './pending'
import { ThreadRows } from './ThreadRows'
import { mainEdits, STAGE_TEXT, threadStage, type ThreadStage } from './threadStatus'
import { answeredSince, composerTarget, pickItems, threadKind, threadLabels, threadNodes, threadsRunning, type ThreadKind } from './threads'
import { RoleChip } from './RoleChip'
import { useChat, type ChatState } from './useChat'
import { pendingAsks, waitingAt, waitingChats } from './waiting'
import { PermissionCard } from './PermissionCard'
import { AttachBar, PrecachedCard, attachInstead, precachedMark, takesFollowUps } from './Precached'
import { pendingRequests } from './permissions'

const LIST_DEBOUNCE_MS = 300
const ANCHORS_SHOWN = 6
/** How long (ms) after a failed read of the settings the Start gate reads them again. */
const SETTINGS_RETRY_MS = 3000

/** What the composer's stop square stops in the thread shown: the session of the orientation, a writer or a check's
 * run (backend agents.interrupt_route), the dev ticket the thread runs (dev.stop_ticket), or the view's build
 * (views.stop_build) or its review's revision (view_review.stop) in the view's thread. */
export type ComposerStop =
  | { kind: 'session'; chat: string; role: string; label: string }
  | { kind: 'ticket'; ticket: string; label: string }
  | { kind: 'view'; slug: string; review: boolean; label: string }

const STOP_LABELS: Readonly<Record<string, string>> = { orient: 'Stop the orientation', writer: 'Stop the writer', check: 'Stop the check' }

type StopMeta = Pick<ChatMeta, 'id' | 'status'> & Partial<Pick<ChatMeta, 'role' | 'agent_type'>>

/** Whether a chat is the critique's, a step of the orientation run by its critic (`thimble:critic`) or an extension's
 * critic program. Pure. */
const isCritique = (m: StopMeta | null): boolean => !!m && m.role === 'step' && !!m.agent_type?.endsWith(':critic')
const CRITIQUE_STOP = 'Stop the critique'

/** The Stop the composer carries for the thread shown, while what it stops runs: a session's (STOP_LABELS), its dev
 * ticket's, or, in a view's thread, the view's build while its proposal is queued or building and else its review's
 * while the review runs (`view`, the thread's proposal). A step, a part of its parent's session whose composer sends to
 * that parent (threads.composerTarget), carries its parent's Stop (`parent`, the step's parent chat) while the parent
 * runs. The critique's thread, and a step of the critic's, stops only the critique, which the orientation then goes on
 * without. Null for main and its threads, whose turn the browser cannot stop, and for a ticket that waits in the queue
 * (its Discard is at the thread's foot) or that an older chat of a retried ticket ran. Pure. */
export function composerStopOf(
  kind: ThreadKind | null,
  meta: StopMeta | null,
  ticket: Pick<Ticket, 'id' | 'n' | 'status' | 'chat'> | null,
  parent: (StopMeta & Pick<ChatMeta, 'role'>) | null = null,
  view: Pick<Proposal, 'slug' | 'status' | 'chat' | 'review'> | null = null,
): ComposerStop | null {
  if (!meta) return null
  if (kind === 'orient' || kind === 'writer' || kind === 'check') return meta.status === 'running' ? { kind: 'session', chat: meta.id, role: kind, label: STOP_LABELS[kind] } : null
  if (kind === 'step' && isCritique(meta)) return meta.status === 'running' ? { kind: 'session', chat: meta.id, role: 'critic', label: CRITIQUE_STOP } : null
  if (kind === 'step' && parent && isCritique(parent)) return parent.status === 'running' ? { kind: 'session', chat: parent.id, role: 'critic', label: CRITIQUE_STOP } : null
  if (kind === 'step' && parent && parent.status === 'running' && STOP_LABELS[parent.role]) return { kind: 'session', chat: parent.id, role: parent.role, label: STOP_LABELS[parent.role] }
  if (kind === 'dev' && ticket && ticket.chat === meta.id && ticket.status === 'running') return { kind: 'ticket', ticket: ticket.id, label: `Stop ticket #${ticket.n}` }
  if (kind === 'dev' && view && view.chat === meta.id && meta.status === 'running') {
    if (view.status === 'queued' || view.status === 'building') return { kind: 'view', slug: view.slug, review: false, label: 'Stop the build' }
    if (view.review?.state === 'running') return { kind: 'view', slug: view.slug, review: true, label: 'Stop the review' }
  }
  return null
}

/** The composer's Stop sent: a session's through stopSession, a ticket's through dev.stop_ticket, whose record then
 * goes to `onTicket`, a view's build or review through its own route; a failure is a toast, `Could not stop …: <why>`
 * for each. Resolves true when the request went through (the run is ending), false when it failed. */
export function stopRun(ws: string, what: ComposerStop, onTicket: (t: Ticket) => void): Promise<boolean> {
  if (what.kind === 'session') return stopSession(ws, what.chat, what.role)
  if (what.kind === 'view') {
    const noun = what.review ? 'the review' : 'the build'
    return (what.review ? api.viewReviewStop(ws, what.slug) : api.stopViewBuild(ws, what.slug))
      .then(() => (void refreshProposals(ws), true))
      .catch((e: Error) => (bus.emit('toast', { text: `Could not stop ${noun}: ${e.message}`, kind: 'error' }), false))
  }
  return api
    .stopTicket(what.ticket)
    .then(() => api.ticket(what.ticket))
    .then((t) => (onTicket(t), true))
    .catch((e: Error) => (bus.emit('toast', { text: `Could not stop the ticket: ${e.message}`, kind: 'error' }), false))
}

/** How long the stop square stays busy after a Stop went through, at most, should the run not report its end. */
export const STOP_HOLD_MS = 30_000

/** A thread's anchors: the meta's `anchor` split at ',' (a ⌘-drag joins several), empty for main. */
export function threadAnchors(meta: Pick<ChatMeta, 'anchor'> | null | undefined): string[] {
  const a = meta?.anchor?.trim()
  if (!a) return []
  return a
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** What the analyst asked a dev ticket for: the body up to its first blank line or its context block, else the title. Pure. */
export function ticketRequest(t: Pick<Ticket, 'title' | 'body'>): string {
  const head = (t.body ?? '').split(/\n\s*\n|\n---/, 1)[0].trim()
  return head || t.title
}

/** The analyst's own message that led main to file a dev ticket: their last message before main's `agent` record for
 * the ticket's chat, in the same turn; null when there is none. Pure. */
export function ticketAsk(records: readonly ChatRecord[], chat: string): { text: string; index: number } | null {
  const at = records.findIndex((r) => r.type === 'agent' && r.chat === chat)
  for (let i = at - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type === 'user') return { text: r.text, index: i }
    if (r.type === 'done' || r.type === 'error') return null
  }
  return null
}

/** A ticket's shots from its log: a stage line `before shot taken` or `after shot taken` becomes the stored picture for
 * that phase, unless the log has the shot's own record. Pure. */
export function withTicketShots(rows: readonly Row[], ticket: { id: string; before_shot?: string | null; after_shot?: string | null } | null): Row[] {
  if (!ticket) return [...rows]
  const logged = new Set(rows.filter((r) => r.kind === 'shot').map((r) => (r as ShotRow).phase))
  return rows.map((r) => {
    if (r.kind !== 'note') return r
    const m = /^(before|after) shot taken\b/.exec(r.text)
    if (!m) return r
    const phase = m[1] as 'before' | 'after'
    const name = phase === 'before' ? ticket.before_shot : ticket.after_shot
    return name && !logged.has(phase) ? { kind: 'shot', index: r.index, phase, ticket: ticket.id, name } : r
  })
}

/** One run of a view build's session in its thread (viewBuildParts): its rows, the stage lines its status line stands
 * for, and the change it was asked for when no message of the analyst's opens it. */
export interface BuildPart {
  rows: Row[]
  stages: string[]
  request: string | null
}

const CHANGE_ASKED = /^the change asked for: ([\s\S]*)$/

/** A view build's thread in parts, one per run of its session: the first build, then each change. Stage lines leave the
 * rows for the part's status line, except a wait after an API error, which stays a row for its error card. A line
 * saying the session shows no activity holds only until the next row or the next such line. Pure. */
export function viewBuildParts(rows: readonly Row[]): BuildPart[] {
  const blank = (): BuildPart => ({ rows: [], stages: [], request: null })
  const parts: BuildPart[] = [blank()]
  const fresh = () => {
    const cur = parts[parts.length - 1]
    if (cur.rows.length || cur.stages.length || cur.request != null) parts.push(blank())
    return parts[parts.length - 1]
  }
  for (const r of rows) {
    let cur = parts[parts.length - 1]
    const quiet = QUIET_RE.test(cur.stages[cur.stages.length - 1] ?? '')
    if (quiet && (r.kind !== 'note' || QUIET_RE.test(r.text))) cur.stages.pop()
    if (r.kind === 'user') {
      fresh().rows.push(r)
      continue
    }
    if (r.kind !== 'note' || capacityNote(r.text)) {
      cur.rows.push(r)
      continue
    }
    const asked = CHANGE_ASKED.exec(r.text)
    if (!asked) {
      cur.stages.push(r.text)
      continue
    }
    if (cur.rows[0]?.kind === 'user' && !cur.stages.length && cur.request == null) continue
    cur = fresh()
    cur.request = asked[1].trim()
  }
  return parts.filter((p) => p.rows.length || p.stages.length || p.request)
}

/** A view build's stage line (dev.run_view) in the status line's words: its label, its step state, and the detail its
 * tip adds (what the checks found). Pure. */
export function buildStage(line: string): { label: string; state: StepState; detail?: string } {
  const t = line.trim()
  if (t === 'the session writes the view') return { label: 'Writing the view', state: 'running' }
  let m = /^the session fixes what the checks found \(attempt (\d+) of (\d+)\)$/.exec(t)
  if (m) return { label: `Fixing what the checks found · attempt ${m[1]} of ${m[2]}`, state: 'running' }
  m = /^checks (passed|failed): ([\s\S]*)$/.exec(t)
  if (m) {
    const detail = m[2].replace(/\b(\d+) ref\(s\)/g, (_, n: string) => `${n} ${n === '1' ? 'ref' : 'refs'}`).trim()
    return m[1] === 'passed' ? { label: 'Checks passed', state: 'done', detail } : { label: 'Checks failed', state: 'failed', detail }
  }
  m = /^the view did not pass, so a new (session|builder) builds it again from what failed \(repair (\d+) of (\d+)\)$/.exec(t)
  if (m) return { label: `Building again with a new ${m[1] === 'builder' ? 'builder' : 'session'} · repair ${m[2]} of ${m[3]}`, state: 'running' }
  m = /^the session is waiting for an answer; ([\s\S]*)$/.exec(t)
  if (m) return { label: 'Waiting for an answer', state: 'running', detail: m[1] }
  return { label: t.charAt(0).toUpperCase() + t.slice(1), state: 'running' }
}

/** A part's status line: its last stage, running only while the part is `live`, else an unfinished stage reads as
 * stopped; the tip lists every stage. Null for a part with no stage. Pure. */
export function buildStatus(stages: readonly string[], live: boolean): { label: string; state: StepState; tip: string } | null {
  if (!stages.length) return null
  const all = stages.map(buildStage)
  const last = all[all.length - 1]
  const state: StepState = last.state === 'running' && !live ? 'skipped' : last.state
  return { label: last.label, state, tip: all.map((s) => (s.detail ? `${s.label}: ${s.detail}` : s.label)).join('\n') }
}

/** A running agent's progress at its row's edge: its calls answered of those made (30/31); '' before its first. Pure. */
export function stepProgress(rows: readonly Row[]): string {
  const steps = toolSteps(rows.filter((r) => r.kind === 'tool'), true)
  return steps.length ? `${steps.filter((s) => s.state === 'done').length}/${steps.length}` : ''
}

/** The strip's count: its subagents ended (done or failed) of those started (5/8), `8 done` once all have ended; ''
 * when there are none. Pure. */
export function subagentCount(agents: readonly ToolStep[]): string {
  if (!agents.length) return ''
  const ended = agents.filter(stepEnded).length
  return ended < agents.length ? `${ended}/${agents.length}` : `${ended} done`
}

/** The strip behind the composer while the current thread works: what it is doing, its steps and count, or null. Only
 * subagents are listed and counted; a session with no agents yet, or one that only makes calls, shows just the title
 * and its spinner. A dev thread that builds a view (`view`) says so; a thread says where its question is (`stage`,
 * threadStatus.threadStage). Pure. */
export function taskStrip(kind: ThreadKind | null, running: boolean, rows: readonly Row[], metas: ReadonlyMap<string, ChatMeta> = new Map(), view = false, stage: ThreadStage | null = null): { title: string; steps: ToolStep[]; count: string } | null {
  if (!running || kind == null || kind === 'main') return null
  const session = (title: string, own: readonly Row[]) => {
    const steps = sessionSteps(own, metas, true)
    return { title, steps, count: subagentCount(steps) }
  }
  if (kind === 'orient') {
    const runs = orientRuns(rows)
    return session('Orienting', runs[runs.length - 1].rows)
  }
  if (kind === 'writer') return session('Writing', rows)
  // a dev ticket's (or a view's build) and a check's steps are their session's subagents too; their calls are rows in
  // the thread, never steps, so one that only makes calls has no step list
  if (kind === 'dev') return session(view ? 'Building the view' : 'Working on the ticket', rows)
  if (kind === 'check') return session('Working', rows)
  // a thread's or an agent's calls are rows in its thread, never steps
  return { title: kind === 'thread' && stage ? STAGE_TEXT[stage] : 'Working', steps: [], count: '' }
}

export function ChatPanel({ ws, onCollapse }: { ws: string; onCollapse?: () => void }) {
  const [chats, setChats] = useState<ChatMeta[]>([])
  // the thread shown, kept per workspace so a reload opens the same one
  const currentKey = storageKey(ws, 'thread-current')
  const [current, setCurrent] = useState(() => readStorage<string>(currentKey, 'main') || 'main')
  // whether this browser had shown a thread of this workspace before: a pre-cached one first opens on its orientation
  const hadThread = useRef(!!readStorage<string>(currentKey, ''))
  useEffect(() => {
    writeStorage(currentKey, current)
  }, [currentKey, current])
  const [seen, setSeen] = useState<SeenMap>(() => readSeen(ws))
  const main = useChat(ws, 'main')
  const other = useChat(ws, current === 'main' ? null : current)
  const chat: ChatState = current === 'main' ? main : other
  // a message handed over with `openChat`: state, so an openChat for the chat already shown still sends
  const [pendingSend, setPendingSend] = useState<{ chatId: string; text: string; n: number } | null>(null)
  const sendSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  // the start gate, skipped: main keeps a note and stays empty until the analyst asks for something
  const skipKey = storageKey(ws, 'start-skipped')
  const [skipped, setSkipped] = useState(() => readStorage<boolean>(skipKey, false))
  // Start was pressed here: the gate gives way at once, before main's meta names the orientation it asked for
  const [started, setStarted] = useState(false)
  // the tree: collapsed to one row by default
  const treeKey = storageKey(ws, 'threads-collapsed')
  const [treeCollapsed, setTreeCollapsed] = useState(() => readStorage<boolean>(treeKey, true))
  const [stripOpen, setStripOpen] = useState(false)
  // the orientation's row of Settings (backend config.models_for), where the Start gate's model and effort menus open;
  // a read that fails is tried again
  const [orientConf, setOrientConf] = useState<ModelConf | null>(null)
  useEffect(() => {
    let alive = true
    let retry: number | undefined
    const read = () =>
      loadSettings(ws)
        .then((s) => {
          if (alive) setOrientConf(s.models?.orient ?? null)
        })
        .catch(() => {
          if (alive) retry = window.setTimeout(read, SETTINGS_RETRY_MS)
        })
    void read()
    const off = onSettingsChange((w) => w === ws && void read())
    return () => {
      alive = false
      window.clearTimeout(retry)
      off()
    }
  }, [ws])
  // this tab's Start click: when it went out, while it waits for its answer, and what it answered
  const [pendingStart, setPendingStart] = useState<number | null>(null)
  const [startAnswer, setStartAnswer] = useState<StartAnswer | null>(null)
  // the gate's text field, which Edit request on a refused start goes to
  const gateKey = useRef(0)
  // a kept thread that is gone (deleted, or the workspace archived) falls back to main at the first load of the list
  const restored = useRef(false)
  const fresh = useMemo(() => newest<ChatMeta[]>(), [ws])
  const loadList = useCallback(
    () =>
      fresh(api.chats(ws))
        .then((list) => {
          if (list === STALE) return
          setChats(list)
          if (restored.current) return
          restored.current = true
          const pre = hadThread.current ? null : precachedMark(list)?.orientation
          if (pre && list.some((m) => m.id === pre)) return setCurrent(pre)
          setCurrent((cur) => (cur === 'main' || list.some((m) => m.id === cur) ? cur : 'main'))
        })
        .catch(() => undefined),
    [ws, fresh],
  )
  useEffect(() => {
    void loadList()
    let timer: number | null = null
    const off = bus.on('chat', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadList(), LIST_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [loadList])

  useEffect(
    () =>
      bus.on('openChat', (e) => {
        if (e.send) setPendingSend({ chatId: e.chatId, text: e.send, n: ++sendSeq.current })
        setCurrent(e.chatId)
        void loadList()
      }),
    [loadList],
  )

  // the handed-over message goes once that chat's own meta is loaded, through the normal streaming path
  useEffect(() => {
    const p = pendingSend
    if (!p || p.chatId !== current || chat.loading || chat.meta == null || chat.meta.id !== current) return
    setPendingSend(null)
    chat.send(p.text)
  }, [pendingSend, current, chat.loading, chat.meta, chat.send])

  // a deleted chat falls back to main, and so does one the server does not have (a workspace archived under the page)
  useEffect(() => bus.on('chat', (e) => e.deleted && e.chat === current && setCurrent('main')), [current])
  useEffect(() => {
    if (current !== 'main' && other.error && /no such chat/.test(other.error)) setCurrent('main')
  }, [current, other.error])

  // a followed `call:` ref (a citation's click, teleport): the thread whose log holds the call opens (the store names it:
  // the orientation's own, or a step's), and the call opens there, marked, its cited lines with it (Rows.CallLine)
  const [focus, setFocus] = useState<CallFocus | null>(null)
  useEffect(
    () =>
      bus.on('openRef', (e) => {
        const p = parseRef(e.ref)
        if (p?.kind !== 'call') return
        track('chip-teleport', { target: e.ref, detail: { kind: 'call' } })
        void fetchCall(ws, p.chat, p.n)
          .then((c) => c.chat || p.chat)
          .catch(() => p.chat)
          .then((holder) => {
            setCurrent(holder)
            setFocus((f) => ({ ref: callRef(p.chat, p.n), line: p.line, endLine: p.endLine, seq: (f?.seq ?? 0) + 1 }))
          })
      }),
    [ws],
  )

  // what asked for the chat while its column was folded (chat/pending.ts), once the listeners above are subscribed
  useEffect(() => {
    replayHeld()
  }, [])

  // the shown chat's records are seen
  const nMessages = countMessages(chat.records)
  useEffect(() => {
    if (chat.loading) return
    setSeen(markSeen(ws, current, nMessages))
  }, [ws, current, nMessages, chat.loading])

  // follow the newest record while the list is near its end; a thread opens at its end
  const nearEnd = useRef(true)
  useEffect(() => {
    nearEnd.current = true
    setStripOpen(false)
  }, [current])
  // a followed call brings itself into view (Rows.CallLine), so the list stops following its end
  useEffect(() => {
    if (focus) nearEnd.current = false
  }, [focus])
  useEffect(() => {
    const el = listRef.current
    if (!el || !nearEnd.current) return
    el.scrollTop = el.scrollHeight
  }, [chat.rows, chat.streaming, main.rows, current])
  // the composer floats over the transcript, so the list keeps its height clear at the bottom; a growing foot only moves
  // the list's padding, which no scroll follows, so a list followed to its end is taken to its new end
  useEffect(() => {
    const foot = footRef.current
    const root = rootRef.current
    if (!foot || !root) return
    const set = () => {
      root.style.setProperty('--composer-h', `${foot.offsetHeight}px`)
      const el = listRef.current
      if (el && nearEnd.current) el.scrollTop = el.scrollHeight
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(foot)
    return () => ro.disconnect()
  }, [])
  // rows that fill in later (a card reading its agent's log, a chip learning its name) and a list that shrinks (the
  // tree opened) keep the end in view
  useEffect(() => {
    const el = listRef.current
    const flow = flowRef.current
    if (!el || !flow) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (nearEnd.current) el.scrollTop = el.scrollHeight
      })
    })
    ro.observe(flow)
    // the list's own box, not its content box: the composer's height moves the list's padding, never its box
    ro.observe(el, { box: 'border-box' })
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])

  // the chats a permission prompt waits on: a session's own, and main's that name the thread or subagent that asked
  const waitingIds = useMemo(() => {
    const ids = new Set(waitingChats(chats).map((m) => m.id))
    for (const p of main.meta?.permissions ?? []) if (p.chat) ids.add(p.chat)
    return ids
  }, [chats, main.meta?.permissions])
  const items = useMemo(
    () =>
      pickItems(
        chats,
        (m) => (m.id === current ? chat.running : !!m.running),
        (m) => (m.id === current ? false : isUnread(seen, m.id, m.n_messages)),
        { current, waiting: waitingIds },
      ),
    [chats, current, chat.running, seen, waitingIds],
  )
  const labels = useMemo(() => threadLabels(items), [items])
  // a thread the analyst left while it answered says so once its answer is in: a toast with its chip, beside the dot
  // the thread tree shows; the first list sets the baseline, so a reload toasts nothing
  const threadsWere = useRef<Map<string, boolean> | null>(null)
  const shown = useRef({ current, labels })
  shown.current = { current, labels }
  useEffect(() => {
    const was = threadsWere.current
    threadsWere.current = threadsRunning(chats)
    if (!was) return
    for (const id of answeredSince(was, chats, shown.current.current)) {
      const label = shown.current.labels.get(id) ?? 'thread'
      bus.emit('toast', { text: 'A thread you left has its answer', thread: { id, label } })
    }
  }, [chats])
  const baseNodes = useMemo(() => threadNodes(items), [items])

  const rename = useCallback(
    async (id: string, name: string) => {
      try {
        await api.updateChat(ws, id, { name })
        await loadList()
      } catch (e) {
        bus.emit('toast', { text: `Could not rename the thread: ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, loadList],
  )
  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteChat(ws, id)
        if (id === current) setCurrent('main')
        await loadList()
      } catch (e) {
        bus.emit('toast', { text: `Could not delete the thread: ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, current, loadList],
  )

  // main and every thread run on the session's model, which main's meta carries once the mirror has read it
  const mainModel = main.meta?.attached?.model ?? null
  const curMeta = (chat.meta?.id === current ? chat.meta : null) ?? chats.find((m) => m.id === current) ?? null
  const kind: ThreadKind | null = current === 'main' ? 'main' : curMeta ? threadKind(curMeta) : null
  const agent = kind === 'orient' || kind === 'writer' || kind === 'check' || kind === 'dev' || kind === 'step'
  const running = agent ? curMeta?.status === 'running' : chat.running
  // the dev ticket the thread shows runs (its thread's foot, TicketView), and what the composer's stop square stops
  const [ticket, setTicket] = useTicket<TicketWithShots>(kind === 'dev' && !curMeta?.view ? (curMeta?.ticket ?? null) : null)
  const stepParent = kind === 'step' && curMeta?.parent ? (chats.find((m) => m.id === curMeta.parent) ?? null) : null
  const proposals = useProposals(ws)
  const threadView = kind === 'dev' && curMeta?.view ? (findProposal(proposals, curMeta.view) ?? null) : null
  const stopWhat = composerStopOf(kind, curMeta, ticket, stepParent, threadView)
  const stopKey = stopWhat ? (stopWhat.kind === 'ticket' ? `ticket:${stopWhat.ticket}` : stopWhat.kind === 'view' ? `view:${stopWhat.slug}:${stopWhat.review}` : `chat:${stopWhat.chat}`) : null
  // the Stop that is under way, by stopKey, so another thread's composer is not left busy: from the request until the
  // run ends (its Stop goes, stopKey changes) or STOP_HOLD_MS pass; a failed request clears it at once
  const [stopping, setStopping] = useState<string | null>(null)
  useEffect(() => {
    if (stopping && stopping !== stopKey) setStopping(null)
  }, [stopping, stopKey])
  useEffect(() => {
    if (!stopping) return
    const t = window.setTimeout(() => setStopping((s) => (s === stopping ? null : s)), STOP_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [stopping])
  const stopNow = () => {
    if (!stopWhat || !stopKey || stopping === stopKey) return
    const key = stopKey
    setStopping(key)
    void stopRun(ws, stopWhat, (t) => setTicket(t as TicketWithShots)).then((ok) => ok || setStopping((s) => (s === key ? null : s)))
  }
  // the orientation and the tickets that run: their steps at their rows' edge, and in main the orientation's strip
  const runningAgents = useMemo(() => chats.filter((m) => (threadKind(m) === 'orient' || threadKind(m) === 'writer' || threadKind(m) === 'dev') && m.status === 'running').sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [chats])
  // the orientations' logs are read as well: main leaves out its relay of the summary one handed back
  const orientIds = useMemo(() => chats.filter((m) => threadKind(m) === 'orient').map((m) => m.id), [chats])
  // New orientation, where the latest one cannot be continued: the gate opens in main though an orientation ran
  const [againGate, setAgainGate] = useState(false)
  const showGate = startGateShown({ main: current === 'main', skipped, started, loading: main.loading, error: main.error, orientation: main.meta?.orientation, orientChats: orientIds.length, again: againGate })
  // the orientation's record: Starting…, a start that did not happen, and the gate filled in again from it
  const orientRun = useOrientRun(ws, main.meta?.orientation)
  const restore = useMemo(() => restoreOf(orientRun.run), [orientRun.run])
  // main's meta again when the record changes (its `orientation`, which opens the gate after a refusal)
  const reloadMain = main.reload
  useEffect(() => bus.on('orient', () => void reloadMain()), [reloadMain])
  const onStartAnswer = (a: StartAnswer | null) => {
    setPendingStart(null)
    setStartAnswer(a)
    orientRun.reload()
    void main.reload()
    // started (or an extension's program runs it): the gate gives way at once; refused: it comes back, filled in
    setStarted(!!a && (!!a.agentId || !!a.program))
    if (a && (a.agentId || a.program)) setAgainGate(false)
    // the orientation's thread opens on its first steps, as Start was the analyst's own click here
    const opened = startedChat(a)
    if (opened) setCurrent(opened)
  }
  const agentRows = useAgentRows(ws, [...new Set([...runningAgents.map((m) => m.id), ...orientIds])])
  const orienting = current === 'main' ? runningAgents.find((m) => threadKind(m) === 'orient') : undefined
  const metaMap = useMemo(() => new Map(chats.map((m) => [m.id, m])), [chats])
  // a ticket that waits in the queue, or for the analyst's Start, is not at work: its foot says so (TicketStatus)
  const waitingTicket = kind === 'dev' && !curMeta?.view && ticket?.status === 'queued'
  const strip = waitingTicket ? null : orienting ? taskStrip('orient', true, agentRows.get(orienting.id) ?? [], metaMap) : taskStrip(kind, running, chat.rows, metaMap, !!curMeta?.view, kind === 'thread' ? threadStage(curMeta, running) : null)
  // the orientation waits for its critic's report: the strip says so (subagents' `paused: critique`)
  const pausedFor = (orienting ?? (kind === 'orient' ? curMeta : null))?.paused === 'critique'
  if (strip && pausedFor) strip.title = PAUSED_LINE
  // the orientation the strip follows in main (its retry below), and the session whose strip it is in its own thread
  const stripMeta = orienting ?? (kind === 'orient' ? curMeta : null)
  const stripSession = orienting ?? (kind === 'orient' || kind === 'writer' || kind === 'check' || kind === 'step' || kind === 'dev' ? curMeta : null)
  // the session the strip follows is waiting for the analyst while one of its permission prompts, or its critique's, is
  // open (chat/waiting.ts)
  const stripped = !!strip && !showGate
  const waitingFor = useMemo(() => (stripped && stripSession ? waitingAt(stripSession.id, metaMap.values()) : null), [stripped, stripSession, metaMap])
  const waiting = !!waitingFor
  // every request of every session that waits for the analyst, on the one card above the composer
  const asks = useMemo(() => pendingRequests(main.meta, metaMap.values()), [main.meta, metaMap])
  // the latest orientation, which the orientation's composer and main's message_orientation reach
  const latestOrient = orientIds.length ? [...chats].filter((m) => threadKind(m) === 'orient').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id ?? null : null
  // a workspace installed from a pre-cache (chat/Precached): its orientation keeps a session only from a full export
  const precached = useMemo(() => precachedMark(chats), [chats])
  // where the composer sends (threads.composerTarget), which its placeholder names and whose model its chip shows; in
  // the thread of a pre-cached orientation that kept no session, main
  const target = composerTarget(kind, curMeta, latestOrient && precached?.orientation === latestOrient && !takesFollowUps(precached) ? null : latestOrient)
  const [sendingView, setSendingView] = useState(false)
  // the analyst's messages to the orientation, from their send until its log holds them; `held` while the server holds
  // one until the coverage line is measured
  const [outbox, setOutbox] = useState<{ chat: string; text: string; key: number; held?: boolean }[]>([])
  // the server's text when the orientation cannot take a message here (409 earlier session, 410 earlier version)
  const [orientClosed, setOrientClosed] = useState<{ chat: string; text: string } | null>(null)
  const [sendingOrient, setSendingOrient] = useState(false)
  const outboxSeq = useRef(0)
  // main's session as the composer shows it (ModelLine): its effort and fast mode, and whether one is attached at all,
  // which is known once main's meta has loaded
  const attached = main.meta?.attached ?? null
  const detached = !!main.meta && !attached
  // whether no session was ever attached to a pre-cached workspace, while the composer would reach nothing
  const neverAttached = detached && !main.meta?.ended
  // the orientation the composer would reach, when it cannot take a message here: an earlier Claude Code session's or an
  // earlier version's, whose text takes the composer's place (backend orient_session.latest's 409 and 410)
  const orientMeta = target.to === 'orient' ? metaMap.get(target.chat) ?? (curMeta?.id === target.chat ? curMeta : null) : null
  const orientContinue = target.to === 'orient' ? continueOf(curMeta?.id === target.chat ? curMeta : orientMeta, attached?.session) : null
  const orientClosedText =
    target.to === 'orient'
      ? (orientClosed?.chat === target.chat ? orientClosed.text : '') || continueText(orientContinue, lastSession(curMeta?.id === target.chat ? curMeta : orientMeta))
      : ''
  const pickEffort = useCallback(
    (e: MainEffort) => {
      track('chat-settings', { target: 'chat:main', detail: { effort: e } })
      api
        .setEffort(ws, e)
        .then(() => {
          main.reload()
          bus.emit('toast', { text: `Effort ${e}: ${NEXT_LAUNCH}.`, kind: 'info' })
        })
        .catch((err: Error) => bus.emit('toast', { text: `Could not set the effort: ${err.message}`, kind: 'error' }))
    },
    [ws, main.reload],
  )
  const pickFast = useCallback(
    (on: boolean) => {
      track('chat-settings', { target: 'chat:main', detail: { fast: on } })
      api
        .setFast(ws, on)
        .then(() => {
          main.reload()
          bus.emit('toast', { text: `Fast mode ${on ? 'on' : 'off'}: ${NEXT_LAUNCH}.`, kind: 'info' })
        })
        .catch((err: Error) => bus.emit('toast', { text: `Could not set fast mode: ${err.message}`, kind: 'error' }))
    },
    [ws, main.reload],
  )
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => {
        const rows = agentRows.get(n.id)
        return rows && n.running ? { ...n, progress: stepProgress(rows) } : n
      }),
    [baseNodes, agentRows],
  )
  const curPath = labels.get(current) ?? current

  // what main leaves to the work's own cards and threads (model.mainSkips), and its rows without it
  const mainCtx = useMemo<MainContext>(() => {
    const agentsMeta = chats.filter((m) => m.kind === 'agent')
    return {
      spawned: new Set(agentsMeta.map((m) => (m as { tool_use_id?: string | null }).tool_use_id).filter((id): id is string => !!id)),
      summaries: orientIds.flatMap((id) => orientSummaries(agentRows.get(id) ?? [], metaMap.get(id)?.status === 'done')),
      runs: agentsMeta
        .filter((m) => m.role !== 'labels' && m.role !== 'dev' && m.role !== 'check')
        .map((m) => ({ from: m.created_at, to: m.ts_end ?? (m.status === 'running' ? null : (m.last_ts ?? m.created_at)) })),
      views: orientIds.flatMap((id) => madeBy(agentRows.get(id) ?? []).views),
      orientWriters: orientWriters(chats),
    }
  }, [chats, orientIds, agentRows, metaMap])
  const mainSkip = useMemo(() => mainSkips(main.records, mainCtx), [main.records, mainCtx])
  const mainRows = useMemo(() => withApiErrors(foldRecords(main.records, mainSkip)), [main.records, mainSkip])
  // Claude Code's API error that ended main's last turn: its Retry sends the analyst's message again
  const failed = useMemo(() => apiRetry(main.records, mainSkip), [main.records, mainSkip])
  const mainRetry = useMemo(() => (failed && !main.running ? { index: failed.index, onRetry: () => main.send(failed.text), note: MAIN_RETRY_NOTE } : undefined), [failed, main.running, main.send])
  const metas = metaMap

  // the threads asked from main, as notes where they branched
  const branches = useMemo(
    () => chats.filter((m) => m.kind === 'thread' && (m.parent ?? 'main') === 'main').map((m) => ({ id: m.id, created_at: m.created_at, anchors: threadAnchors(m) })),
    [chats],
  )

  // a send that fails hands its text back to the composer (Composer), so nothing typed is lost
  const send = (text: string): Promise<boolean> => {
    if (target.to === 'orient') {
      // the latest orientation takes the analyst's message itself: it resumes the finished session, or waits for the run
      // going on to end; from one of its steps, its thread opens, where the message and the reply show
      const chatId = target.chat
      if (current !== chatId) setCurrent(chatId)
      const key = ++outboxSeq.current
      setSendingOrient(true)
      setOutbox((o) => [...o, { chat: chatId, text, key }])
      return api
        .messageOrientation(ws, text)
        .then((r) => {
          if (r.status === 'held') setOutbox((o) => o.map((m) => (m.key === key ? { ...m, held: true } : m)))
          return true
        })
        .catch((e: Error) => {
          setOutbox((o) => o.filter((m) => m.key !== key))
          // an orientation of an earlier session or version: its text takes the composer's place (one stopped with Esc
          // takes the message, which starts its continuation)
          const closed = /^(409|410)\s+(This orientation ran in an earlier.*)$/s.exec(e.message)
          if (closed) setOrientClosed({ chat: chatId, text: closed[2] })
          else bus.emit('toast', { text: `Your message was not passed on: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' })
          return false
        })
        .finally(() => setSendingOrient(false))
    }
    if (target.to === 'view') {
      // a view build's thread: the message is a change to the view, run by its build in this thread
      const slug = target.slug
      setSendingView(true)
      track('view-build', { target: `view:${slug}`, detail: { change: true } })
      return api
        .messageView(ws, slug, text)
        .then(() => chat.reload())
        .then(() => true)
        .catch((e: Error) => {
          bus.emit('toast', { text: `Could not send it to the view's build. ${e.message}`, kind: 'error' })
          return false
        })
        .finally(() => setSendingView(false))
    }
    if (target.to === 'main') {
      // a ticket, a writer, a check's run and an older orientation run in sessions of their own that take no message;
      // what the analyst says there goes to main, as the composer says
      setCurrent('main')
      return main.send(text)
    }
    return chat.send(text)
  }
  // the composer's chip: the model and effort of the session the message goes to; main's for main and its threads
  const roleChip =
    target.to === 'orient' ? (
      <RoleChip ws={ws} role="orient" label="the orientation" values={orientMeta?.values ?? null} />
    ) : target.to === 'view' ? (
      <RoleChip ws={ws} role="dev" label="the view build" />
    ) : undefined
  const mainChip = !!attached && !roleChip

  return (
    <ThreadsContext.Provider value={{ labels, metas, main: main.meta }}>
      <section
        ref={rootRef}
        className="chat"
        data-panel="chat"
        data-thread-kind={kind ?? undefined}
        data-chat-current={current}
        aria-label="Chat"
        onPointerDown={(e) => {
          // a press anywhere in the chat outside the tree's card folds the open tree. It folds only after the click has landed:
          // folding at the press would move the thread under the pointer and the click would go there
          if (treeCollapsed || (e.target as Element).closest?.('.tt')) return
          const fold = () =>
            window.setTimeout(() => {
              writeStorage(treeKey, true)
              setTreeCollapsed(true)
            }, 0)
          window.addEventListener('pointerup', fold, { once: true })
        }}
      >
        <header className="chat-head">
          <ThreadTree
            className="chat-tree"
            nodes={nodes}
            current={current}
            collapsed={treeCollapsed}
            onCollapsedChange={(c) => {
              writeStorage(treeKey, c)
              setTreeCollapsed(c)
            }}
            onPick={(id) => {
              if (id !== current) track('thread-switch', { target: `chat:${id}` })
              setCurrent(id)
            }}
            onRename={rename}
            onDelete={remove}
            aside={onCollapse && <Button variant="icon" size="sm" icon="panel-left" title="Collapse the chat" className="chat-head-collapse" onClick={onCollapse} />}
          />
        </header>
        <UnfencedBanner main={main.meta} />
        <div
          className="chat-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <CallFocusContext.Provider value={focus}>
          <div className="chat-flow" ref={flowRef}>
            {chat.loading && (
              <div className="chat-empty">
                <Spinner size={14} label="Loading" />
              </div>
            )}
            {chat.error && <div className="chat-error">{chat.error}</div>}
            {!chat.loading && !chat.error && kind === 'main' && (
              <>
                {skipped && <Note className="chat-skipped" text={SKIPPED_NOTE} />}
                {precached?.orientation && !mainRows.length && <Note className="chat-origin" text="The orientation ran in advance:" chips={<ThreadChip id={precached.orientation} />} />}
                <Rows rows={withBranches(mainRows, main.records, branches)} ws={ws} chat="main" streaming={main.streaming} retry={mainRetry} />
                <OrientStart
                  ws={ws}
                  run={orientRun.run}
                  answer={startAnswer}
                  pendingSince={pendingStart}
                  onStarted={(a) => onStartAnswer(a)}
                  onEdit={() => {
                    setSkipped(false)
                    setStarted(false)
                    window.requestAnimationFrame(() => footRef.current?.querySelector<HTMLTextAreaElement>('.chat-gate-text')?.focus())
                  }}
                />
              </>
            )}
            {!chat.loading && !chat.error && kind === 'thread' && curMeta && <ThreadView ws={ws} meta={curMeta} chat={chat} main={main} skip={mainSkip} branches={branches} detached={detached} />}
            {!chat.loading && !chat.error && kind === 'orient' && <SessionView ws={ws} id={current} chat={chat} role="orient" title="Orientation" running={running} outbox={outbox.filter((m) => m.chat === current)} attached={!!attached} />}
            {!chat.loading && !chat.error && kind === 'writer' && <SessionView ws={ws} id={current} chat={chat} role="writer" title={curMeta?.title || 'Writer'} running={running} />}
            {!chat.loading && !chat.error && kind === 'check' && <SessionView ws={ws} id={current} chat={chat} role="check" title={curMeta?.title || 'Check'} running={running} fromMain={false} />}
            {!chat.loading && !chat.error && kind === 'dev' && <DevView ws={ws} id={current} chat={chat} mainRecords={main.records} ticket={ticket} onTicket={setTicket} />}
            {!chat.loading && !chat.error && kind === 'step' && curMeta && <StepView ws={ws} meta={curMeta} chat={chat} running={running} />}
          </div>
          </CallFocusContext.Provider>
        </div>
        <div ref={footRef} className="chat-foot">
          <Holds className="chat-main-holds" alert={main.meta?.alert} />
          {asks.length > 0 && <PermissionCard ws={ws} asks={asks} metas={metaMap} labels={labels} />}
          {strip && !showGate && <TaskStrip title={strip.title} steps={strip.steps} count={strip.count} open={stripOpen} onToggle={() => setStripOpen((o) => !o)} waiting={waiting} />}
          {showGate ? (
            <StartGate
              key={`gate:${restore ? orientRun.run?.request ?? 'refused' : 'new'}:${gateKey.current}`}
              ws={ws}
              main={main.meta}
              model={orientConf?.model ?? null}
              effort={orientConf?.effort ?? null}
              restore={restore}
              onStarting={() => {
                // the gate closes at once; Starting… shows after a second without the answer, and a refusal opens it again
                setStartAnswer(null)
                setPendingStart(Date.now())
                setStarted(true)
              }}
              onAnswer={onStartAnswer}
              onSkip={() => {
                writeStorage(skipKey, true)
                setSkipped(true)
              }}
            />
          ) : precached && attachInstead(precached, neverAttached, target.to) ? (
            <AttachBar mark={precached} />
          ) : orientClosedText ? (
            <div className="chat-continue" role="note" data-continue={orientContinue ?? undefined}>
              <Icon name="terminal" size={13} className="chat-continue-ico" />
              <span>{orientClosedText}</span>
              <Button
                size="sm"
                variant="secondary"
                className="chat-continue-new"
                onClick={() => {
                  // the Start gate in main, as before the first orientation, since this one takes no message
                  setCurrent('main')
                  setStarted(false)
                  setAgainGate(true)
                }}
              >
                New orientation
              </Button>
            </div>
          ) : (
            <Composer
              model={mainModel}
              effort={mainChip ? mainEffort(attached) : null}
              onEffort={mainChip ? pickEffort : undefined}
              fast={mainChip ? mainFast(attached) : null}
              onFast={mainChip ? pickFast : undefined}
              chip={roleChip}
              onSend={send}
              sending={target.to === 'orient' ? sendingOrient : target.to === 'view' ? sendingView : target.to === 'main' ? main.streaming : chat.streaming}
              placeholder={`Reply in ${target.to === 'main' ? 'main' : target.to === 'orient' ? labels.get(target.chat) ?? 'orient' : curPath}…`}
              disabled={chat.loading || !!chat.error}
              stop={stopWhat ? { label: stopWhat.label, onStop: stopNow, busy: stopping === stopKey } : undefined}
              thread={current}
            />
          )}
        </div>
      </section>
    </ThreadsContext.Provider>
  )
}

/** The kinds of a thread's `error` record that end a run without a reply the analyst can read (backend
 * threads.STOP_KINDS). */
export const THREAD_STOP_KINDS: ReadonlySet<string> = new Set(['session-ended', 'unanswered', 'fork-lost', 'failed', 'stopped'])

/** Whether a thread offers Ask again: its last run ended with one of THREAD_STOP_KINDS and nothing came after it (no
 * question, reply, finished run, or asking again). Pure. */
export function canAskAgain(records: readonly ChatRecord[], running: boolean): boolean {
  if (running) return false
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as ChatRecord | { type: 'again' }
    if (r.type === 'error') return THREAD_STOP_KINDS.has(r.kind ?? r.message)
    if (r.type === 'user' || r.type === 'done' || r.type === 'again' || (r.type === 'text' && r.reply)) return false
  }
  return false
}

/** The Retry of a thread whose reply ended on Claude Code's API error: the error row when it is the thread's last and
 * the thread is not working, which asks the thread's unanswered questions again (threads.ask_again); else undefined.
 * Pure but for `ask`. */
export function threadRetry(rows: readonly Row[], running: boolean, ask: () => Promise<unknown>): ErrorRetry | undefined {
  const last = rows[rows.length - 1]
  if (running || !last || last.kind !== 'error' || last.errorKind !== API_ERROR_KIND) return undefined
  return { index: last.index, onRetry: ask, note: THREAD_RETRY_NOTE }
}

/** A fork of main: main up to the branch, the line that says when, what it was asked about, then its own rows, and Ask
 * again under a run that ended without a reply, or Retry on an API error that ended it. */
function ThreadView({ ws, meta, chat, main, skip, branches, detached }: { ws: string; meta: ChatMeta; chat: ChatState; main: ChatState; skip: ReadonlySet<number>; branches: { id: string; created_at: string; anchors: string[] }[]; detached: boolean }) {
  const cut = useMemo(() => branchIndex(main.records, meta.created_at), [main.records, meta.created_at])
  const inherited = useMemo(() => {
    const records = main.records.slice(0, cut)
    return withBranches(withApiErrors(foldRecords(records, skip)), records, branches.filter((b) => b.id !== meta.id))
  }, [main.records, cut, skip, branches, meta.id])
  const anchors = threadAnchors(meta)
  // main's own edits of the cards the thread is anchored on, which main's log holds
  const edits = useMemo(() => mainEdits(chat.records, main.rows, threadAnchors(meta)), [chat.records, main.rows, meta])
  return (
    <>
      <Rows rows={inherited} ws={ws} chat="main" />
      <Divider text={`branched from main · ${hhmm(meta.created_at)}`} />
      {anchors.length > 0 && (
        <Note
          className="chat-anchor-note"
          data-anchors={anchors.length}
          text="Anchored on"
          chips={
            <>
              {anchors.slice(0, ANCHORS_SHOWN).map((a, i) => (
                <RefChip key={`${a}:${i}`} ref={a} compact workspace={ws} />
              ))}
              {anchors.length > ANCHORS_SHOWN && <Chip kind="value">+{anchors.length - ANCHORS_SHOWN}</Chip>}
            </>
          }
        />
      )}
      <ThreadRows rows={chat.rows} edits={edits} ws={ws} chat={meta.id} streaming={chat.streaming} retry={threadRetry(chat.rows, chat.running, () => api.askAgain(ws, meta.id).then(() => chat.reload()))} />
      {canAskAgain(chat.records, chat.running) && <AskAgain ws={ws} id={meta.id} detached={detached} onAsked={chat.reload} />}
    </>
  )
}

/** Ask again under a thread's run that ended without a reply: its unanswered questions go to the session that is main
 * now (backend threads.ask_again); disabled while no session is attached (shell/SessionGone). */
function AskAgain({ ws, id, detached, onAsked }: { ws: string; id: string; detached: boolean; onAsked: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const ask = () => {
    setBusy(true)
    track('thread-ask-again', { target: `chat:${id}` })
    api
      .askAgain(ws, id)
      .then(() => onAsked())
      .catch((e: Error) => bus.emit('toast', { text: `Could not ask again: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <Note
      className="chat-ask-again"
      chips={
        <Chip kind="status" face="sans" className="chat-ask-again-chip" disabled={busy || detached} onClick={ask}>
          Ask again
        </Chip>
      }
    />
  )
}

/** The rows of the orientation or a writer as its thread shows them: its whole session less its first message, which
 * is the card's. For an orientation that ran as main's subagent (an earlier build's; it now runs as its own background
 * session), its hand-back summary replaces the hand-back call and what followed. Pure. */
export function orientMessages(rows: readonly Row[]): Row[] {
  const first = rows.findIndex((r) => r.kind === 'user')
  const own = rows.filter((_, i) => i !== first)
  const back = [...own].reverse().find((r) => r.kind === 'tool' && r.name === 'SubagentHandback')
  if (!back || back.kind !== 'tool') return own
  const inp = (back.input && typeof back.input === 'object' ? back.input : {}) as Record<string, unknown>
  const summary = typeof inp.message === 'string' ? inp.message.trim() : ''
  const rest = own.filter((r) => r !== back)
  if (!summary) return rest
  const summaryRow: Row = { kind: 'text', index: back.index, text: summary }
  return [...rest.filter((r) => r.index < back.index || r.kind !== 'text'), summaryRow].sort((a, b) => a.index - b.index)
}

/** An orientation's call numbers by tool_use id, read from its store's index while any call in `rows` has none in its
 * record; empty otherwise. */
function useCallIndex(ws: string, chat: string | null, rows: readonly Row[]): ReadonlyMap<string, number> {
  const [index, setIndex] = useState<ReadonlyMap<string, number>>(new Map())
  const missing = useMemo(() => rows.filter((r) => r.kind === 'tool' && r.n == null && !index.has(r.id)).length, [rows, index])
  useEffect(() => setIndex(new Map()), [ws, chat])
  useEffect(() => {
    if (!chat || !missing) return
    let alive = true
    api
      .callIndex(ws, chat)
      .then((d) => {
        const list = Array.isArray(d) ? d : (d.calls ?? [])
        if (alive) setIndex(new Map(list.filter((c) => c && typeof c.id === 'string' && typeof c.n === 'number').map((c) => [c.id, c.n] as const)))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // read again when calls without a number arrive, not on every row
  }, [ws, chat, missing > 0 ? rows.length : 0])
  return index
}

/** The note under a message the server holds until the coverage line is measured, which goes with it. */
export const HELD_NOTE = 'Sent when the coverage check ends (at most 2 minutes)'

/** A message on its way to the orientation: the analyst's tile, with a spinner, or the note that it is held. */
function PendingMessage({ text, ws, held }: { text: string; ws: string; held: boolean }) {
  return (
    <div className="chat-msg chat-user chat-pending" data-held={held || undefined}>
      <UserMessage className="chat-message">
        <RefText text={text} workspace={ws} />
      </UserMessage>
      <Note className="chat-pending-note" spin={!held} text={held ? HELD_NOTE : undefined} />
    </div>
  )
}

/** The thread of the orientation, a writer or a check's run: where it came from, the orientation's request as the
 * analyst's message, its card, then its whole transcript (orientMessages); then the analyst's messages still on their
 * way (`outbox`). An orientation that main's quit stopped and `thimble --continue` brought back says a message continues
 * it. */
function SessionView({ ws, id, chat, role, title, running, outbox = [], fromMain = true, attached = false }: { ws: string; id: string; chat: ChatState; role: string; title: string; running: boolean; outbox?: readonly { text: string; held?: boolean }[]; fromMain?: boolean; attached?: boolean }) {
  const orient = role === 'orient'
  // an orientation `thimble demo` installed from a pre-cache, which ran in advance with no session kept
  const mark = orient && chat.meta?.id === id ? chat.meta?.precached ?? null : null
  const own = useMemo(() => orientMessages(chat.rows), [chat.rows])
  const index = useCallIndex(ws, orient ? id : null, own)
  const rows = useMemo(() => withCallNumbers(own, index), [own, index])
  const log = useMemo(() => ({ meta: chat.meta, records: chat.records as ChatRecord[], error: chat.error }), [chat.meta, chat.records, chat.error])
  const meta = chat.meta?.id === id ? chat.meta : null
  const here = orient && !running && meta?.status === 'stopped' && meta.stopped_by === 'quit' && meta.continue === 'here'
  // stopped with Esc, which Claude Code resumes no more: a message starts a continuation in this thread (U2)
  const escStopped = orient && !running && meta?.continue === 'stopped-by-user'
  // a message sent from here is shown until the log holds it (a follow-up's first record)
  const landed = landedTexts(chat.rows)
  const sending = outbox.filter((m) => !landed.has(m.text.trim()))
  return (
    <>
      {mark && <PrecachedCard mark={mark} attached={attached} />}
      {fromMain && !mark && <Note className="chat-origin" text="Started from main" chips={<ThreadChip id="main" />} />}
      <AgentCard ws={ws} chat={id} role={role} title={title} log={log} openWhileRunning stopHere={false} briefAbove={orient} />
      <Rows rows={rows} ws={ws} chat={id} calls={orient ? id : undefined} live={running} />
      {here && <Note className="chat-continue-here" text={CONTINUE_HERE_LINE} />}
      {escStopped && <Note className="chat-continue-here" data-continue="stopped-by-user" text={STOPPED_CONTINUE_LINE} />}
      {sending.map((m, i) => (
        <PendingMessage key={`s:${i}:${m.text}`} text={m.text} ws={ws} held={!!m.held} />
      ))}
    </>
  )
}

/** A step of the orientation: the transcript of one of its session's subagents or workflow agents, under a note that
 * goes back to the orientation. Its calls are the orientation's, numbered in the same sequence, so each carries its ref. */
function StepView({ ws, meta, chat, running }: { ws: string; meta: ChatMeta; chat: ChatState; running: boolean }) {
  const { metas } = useContext(ThreadsContext)
  const parent = meta.parent ? metas?.get(meta.parent) : undefined
  const orient = parent && threadKind(parent) === 'orient' ? parent.id : null
  const index = useCallIndex(ws, orient, chat.rows)
  const rows = useMemo(() => withCallNumbers(chat.rows, index), [chat.rows, index])
  // a step that is a session of its own (the orientation's critique, backend critique_session.py) asks in its own chat
  const own = chat.meta?.id === meta.id ? chat.meta : meta
  return (
    <>
      <Note className="chat-origin" text="A step of" chips={<ThreadChip id={meta.parent ?? 'main'} />} />
      <Holds className="chat-step-holds" rules={running ? own.session_rules : null} />
      <Rows rows={rows} ws={ws} chat={meta.id} calls={orient ?? undefined} live={running} />
    </>
  )
}

/** A ticket as the dev route serves it: who filed it (`analyst` for main's file_dev_ticket, `ui` for the browser's
 * ticket box) and the file names of its shots (dev.py `_take_shot`). */
type TicketWithShots = Ticket & { source?: string; before_shot?: string | null; after_shot?: string | null }

/** A view ticket's build (dev.run_view): the proposal it builds, folded, then each run of its session (viewBuildParts)
 * with its request, transcript and one status line. */
function ViewBuildView({ ws, id, chat, slug }: { ws: string; id: string; chat: ChatState; slug: string }) {
  const p = findProposal(useProposals(ws), slug)
  const parts = useMemo(() => viewBuildParts(chat.rows), [chat.rows])
  return (
    <>
      {p && <SpecCard className="chat-proposal" title="Proposal" lead={firstSentence(`${p.why} ${p.arrangement}`)} full={[p.why, p.arrangement].filter(Boolean).join('\n\n')} end={<ViewChip ws={ws} slug={p.slug} name={p.name} />} data-anchor={`view:${p.slug}`} />}
      {parts.map((part, i) => {
        const status = buildStatus(part.stages, chat.running && i === parts.length - 1)
        return (
          <Fragment key={part.rows[0]?.index ?? `p${i}`}>
            {part.request && <SpecCard className="chat-change" title="Change" lead={firstSentence(part.request)} full={part.request} />}
            <Rows rows={part.rows} ws={ws} chat={id} />
            {status && <BuildStatusLine {...status} />}
          </Fragment>
        )
      })}
    </>
  )
}

/** A run's status line: the glyph of its last stage and what it says, every stage of the run in its tooltip. */
function BuildStatusLine({ label, state, tip: text }: { label: string; state: StepState; tip: string }) {
  const { props, tip } = useTooltip(text, 'tip-lines')
  return (
    <div className={`chat-row chat-build-status toolcard-step toolcard-step-${state}`} data-state={state} {...props}>
      <StepGlyph state={state} />
      <span className="toolcard-step-text">{label}</span>
      {tip}
    </div>
  )
}

/** The first sentence of `text` on one line, which a folded SpecCard shows. Pure. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const end = t.search(/[.!?](\s|$)/)
  return end < 0 ? t : t.slice(0, end + 1)
}

/** What a view's build works from, in its thread: the proposal at the top, and a change main asked for at the start of
 * its run. Folded to its title and first sentence, open on the whole text; `end` sits at the head's right edge. */
function SpecCard({ title, lead, full, end, className, ...data }: { title: string; lead: string; full: string; end?: ReactNode; className?: string; [k: `data-${string}`]: string | undefined }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((o) => !o)
  return (
    <div className={`toolcard chat-spec${className ? ` ${className}` : ''}${open ? ' open' : ''}`} {...data}>
      <div
        className="toolcard-head toolcard-head-act"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <span className="toolcard-caret" aria-hidden="true">
          <Icon name="chevron-right" size={10} strokeWidth={2.7} />
        </span>
        <span className="toolcard-title">{title}</span>
        {end && (
          <span className="toolcard-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {end}
          </span>
        )}
      </div>
      {open ? (
        <div className="chat-spec-full">{full}</div>
      ) : (
        <div className="chat-spec-lead" onClick={toggle}>
          {lead}
        </div>
      )}
    </div>
  )
}

/** A dev chat's thread: a view's build, or a ticket's, whose record ChatPanel reads (useTicket) for the composer's Stop
 * as well. */
function DevView({ ws, id, chat, mainRecords, ticket, onTicket }: { ws: string; id: string; chat: ChatState; mainRecords: readonly ChatRecord[]; ticket: TicketWithShots | null; onTicket: (t: TicketWithShots) => void }) {
  const view = chat.meta?.view ?? null
  if (view) return <ViewBuildView ws={ws} id={id} chat={chat} slug={view} />
  return <TicketView ws={ws} id={id} chat={chat} mainRecords={mainRecords} ticket={ticket} onTicket={onTicket} />
}

/** A dev ticket's thread: where it came from, what the analyst asked for in their own words, the brief main filed from
 * it, then the whole run of its session, its shots as pictures, and its state at the foot (TicketStatus); its Stop is
 * the composer's. */
function TicketView({ ws, id, chat, mainRecords, ticket, onTicket: setTicket }: { ws: string; id: string; chat: ChatState; mainRecords: readonly ChatRecord[]; ticket: TicketWithShots | null; onTicket: (t: TicketWithShots) => void }) {
  // a ticket from the browser's ticket box is the analyst's own words already; one main filed is main's brief
  const ask = useMemo(() => (ticket && ticket.source !== 'ui' ? ticketAsk(mainRecords, id) : null), [ticket, mainRecords, id])
  const rows = useMemo(() => withTicketShots(chat.rows, ticket), [chat.rows, ticket])
  return (
    <>
      <Note className="chat-origin" text="Started from main" chips={<ThreadChip id="main" />} />
      {ask ? (
        <>
          <div className="chat-msg chat-user">
            <UserMessage className="chat-message" data-anchor={`chat:main#${ask.index}`} data-anchor-text={ask.text}>
              <RefText text={ask.text} workspace={ws} />
            </UserMessage>
          </div>
          {ticket && <Note className="chat-ticket-brief" data-anchor={`ticket:${ticket.id}`} text={`Ticket #${ticket.n} · ${ticketRequest(ticket)}`} />}
        </>
      ) : (
        ticket && (
          <div className="chat-msg chat-user">
            <UserMessage className="chat-message" data-anchor={`ticket:${ticket.id}`}>
              {ticketRequest(ticket)}
            </UserMessage>
          </div>
        )
      )}
      <Rows rows={rows} ws={ws} chat={id} />
      {/* the state of the ticket this chat runs; an older chat of a retried ticket shows none */}
      {ticket && ticket.chat === id && <TicketStatus ticket={ticket} waiting={pendingAsks(chat.meta).length > 0} onChange={(t) => setTicket(t as TicketWithShots)} />}
    </>
  )
}

/** The strip behind the composer's top edge while the thread works: the spinner, what it is doing, how many steps; it
 * opens on the steps. A pending permission prompt shows a still dot in place of the spinner; a session waiting to retry
 * after an API capacity error shows a countdown row with Retry now. */
function TaskStrip({ title, steps, count, open, onToggle, waiting = false, retry = null, onRetry }: { title: string; steps: ToolStep[]; count: string; open: boolean; onToggle: () => void; waiting?: boolean; retry?: SessionAlert | null; onRetry?: () => Promise<unknown> }) {
  const retryLine = useRetryText(retry)
  const [retrying, setRetrying] = useState(false)
  const retryNow = () => {
    if (!onRetry) return
    setRetrying(true)
    onRetry()
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry: ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  const listRef = useRef<HTMLOListElement>(null)
  // the list keeps the step that runs in view
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open, steps.length])
  return (
    <div className={`chat-strip${open ? ' open' : ''}${waiting ? ' is-waiting' : ''}`} data-steps={steps.length} data-waiting={waiting || undefined} data-retry={retry ? '' : undefined}>
      <div className="chat-strip-bar">
        <button type="button" className="chat-strip-head" aria-expanded={open} onClick={onToggle}>
          {waiting || retry ? <span className="chat-strip-wait-dot" aria-hidden="true" /> : <Spinner label="working" />}
          <span className="chat-strip-title">{title}</span>
          {/* subagents only (subagentCount); the strip shows while the session runs, so all ended does not mean finished */}
          {count && <span className="chat-strip-meta">{count}</span>}
          <Icon name="chevron-down" size={12} className="chat-strip-caret" />
        </button>
      </div>
      {retry && (
        <div className="chat-strip-retry-row">
          <span className="chat-strip-retry-text" role="status">
            {retryLine}
          </span>
          {onRetry && (
            <Chip kind="status" tone="warning" face="sans" className="chat-strip-retry" disabled={retrying} onClick={retryNow}>
              Retry now
            </Chip>
          )}
        </div>
      )}
      {open && steps.length > 0 && (
        <ol ref={listRef} className="chat-strip-steps">
          {steps.map((s, i) => (
            <li key={s.key ?? i} className={`toolcard-step toolcard-step-${s.state ?? 'done'}`}>
              <StepGlyph state={s.state ?? 'done'} />
              <span className="toolcard-step-text">{s.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
