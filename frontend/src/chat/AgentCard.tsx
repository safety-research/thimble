// A subagent or workflow agent as a chip (AgentChip): its name, steps, duration, state and the chips of what it made;
// open, the files its calls read and its calls as plain-word steps (model.plainStep).
//
// The orientation and a writer, each a Claude Code session of its own, are a tool-call card whose steps are that
// session's subagents and workflow agents (sessionSteps). While it runs the card shows what holds the session (Holds)
// and Stop (in its own thread the composer's stop square is its Stop instead, ChatPanel); its permission requests wait
// on the one permission card above the composer (PermissionCard), and its permission mode shows beside them
// (ModeSwitch). In main, a finished orientation's card follows one line counting what it left for review. A follow-up
// of the orientation is the same card for that run alone (`run`), with what it changed and Undo while the last undo
// step is that follow-up's (backend undo.py).
import { useContext, useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { RefChip } from '../components/RefChip'
import { Mark } from '../components/Marks'
import { Spinner } from '../components/Spinner'
import { UserMessage } from '../components/Message'
import { ChipRun, StepGlyph, ToolCard, type ToolSection, type ToolState } from '../components/ToolCard'
import { api, undoApi } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { useProposals, withoutDropped } from '../lib/proposals'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { ChatMeta, ChatRecord } from '../lib/types'
import { ApiErrorCard } from './ApiError'
import { Holds } from './Holds'
import { ModeSwitch } from './ModeSwitch'
import { waitingAt } from './waiting'
import { agentChipName, agentFiles, apiErrorAt, changeSummary, deckCards, durationText, foldRecords, followUpSummary, lastRowTs, leadText, madeBy, madeCards, orientMade, orientRuns, orientWriterOf, orientWriters, reviewList, sessionSteps, stripHarness, taskTitle, toolSteps, type Made, type OrientWriter, type Row } from './model'
import { openThread, ThreadChip, ThreadsContext } from './Notes'
import { DocChip, GroupChip, LabelChip } from './SurfaceChips'
import { ViewChip } from './ViewChip'
import { failureText, ReportProblemButton } from '../shell/ProblemReport'
import { RefText } from './markdown'

const REFETCH_DEBOUNCE_MS = 150
/** The roles of the sessions thimble starts beside main (agent_session.py): their card lists their agents as steps and
 * carries what holds them and Stop. A report check's run is one (backend checks.py). */
const SESSION_ROLES = new Set(['orient', 'writer', 'check'])

/** An agent chat's meta and records, refetched on the stream's `chat` events for it; nothing for a null chat. */
export function useAgentLog(ws: string, chat: string | null): { meta: ChatMeta | null; records: ChatRecord[]; error: string | null } {
  const [meta, setMeta] = useState<ChatMeta | null>(null)
  const [records, setRecords] = useState<ChatRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setMeta(null)
    setRecords([])
    if (chat == null) return
    let alive = true
    let timer: number | null = null
    const load = () =>
      api
        .chat(ws, chat)
        .then((d) => {
          if (!alive) return
          setMeta(d.meta)
          setRecords(d.events)
          setError(null)
        })
        .catch((e) => alive && setError((e as Error).message))
    void load()
    const off = bus.on('chat', (e) => {
      if (e.chat !== chat) return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), REFETCH_DEBOUNCE_MS)
    })
    return () => {
      alive = false
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, chat])
  return { meta, records, error }
}

/** The logs of the agent chats in `ids` (the orientation and tickets that run), each folded, refetched on the stream's
 * `chat` events for them. */
export function useAgentRows(ws: string, ids: readonly string[]): ReadonlyMap<string, Row[]> {
  const [rows, setRows] = useState<ReadonlyMap<string, Row[]>>(new Map())
  const key = ids.join(',')
  useEffect(() => {
    const want = key ? key.split(',') : []
    setRows((cur) => new Map([...cur].filter(([id]) => want.includes(id))))
    if (!want.length) return
    let alive = true
    const timers = new Map<string, number>()
    const load = (id: string) =>
      api
        .chat(ws, id)
        .then((d) => alive && setRows((cur) => new Map(cur).set(id, foldRecords(d.events))))
        .catch(() => undefined)
    want.forEach((id) => void load(id))
    const off = bus.on('chat', (e) => {
      if (!want.includes(e.chat)) return
      window.clearTimeout(timers.get(e.chat))
      timers.set(e.chat, window.setTimeout(() => void load(e.chat), REFETCH_DEBOUNCE_MS))
    })
    return () => {
      alive = false
      off()
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [ws, key])
  return rows
}

const showTab = (tab: Tab) => bus.emit('showTab', { tab })

/** A label chip goes to the label's card, else to Files, where the labels are. */
export function openLabel(ws: string, name: string) {
  track('chip-teleport', { target: `label:${name}`, detail: { kind: 'section' } })
  api
    .concepts(ws)
    .then((cs) => {
      const c = cs.find((x) => x.name === name)
      if (c) teleport(`concept:${c.id}`)
      else showTab('files')
    })
    .catch(() => showTab('files'))
}

/** The section rows of what a run made: one per surface it landed on. `writer` is the writer of the orientation's
 * report pass, shown under Report with its document's chip or its progress. */
export function madeSections(ws: string, made: Made, opts: { report?: string | null; writer?: OrientWriter | null } = {}): ToolSection[] {
  const out: ToolSection[] = []
  if (made.views.length) {
    out.push({
      key: 'views',
      label: 'Views',
      onOpen: () => showTab('files'),
      chips: made.views.map((v) => <ViewChip key={v} ws={ws} slug={made.viewSlugs?.[v]} name={v} />),
    })
  }
  if (made.cells.length || made.labelCards.length) {
    // a group's count is every card the run left in it, its labels' cards included, as the canvas counts them; its chip
    // opens focus mode on the first card of the frame its first card sits in (the orientation's deck from its chip)
    const groups = new Map<string, { ids: string[]; n: number }>()
    const inGroup = (g: string) => {
      let entry = groups.get(g)
      if (!entry) groups.set(g, (entry = { ids: [], n: 0 }))
      return entry
    }
    for (const c of made.cells) {
      if (!c.group) continue
      const g = inGroup(c.group)
      g.ids.push(c.id)
      g.n += 1
    }
    for (const l of made.labelCards) if (l.group) inGroup(l.group).n += 1
    const loose = made.cells.filter((c) => !c.group).map((c) => c.id)
    out.push({
      key: 'canvas',
      label: 'Canvas',
      onOpen: () => showTab('canvas'),
      chips: (
        <>
          {[...groups].map(([g, { ids, n }]) => (
            <GroupChip key={g} name={made.groupNames?.[g] ?? g} count={n} anchor={ids[0] ? `card:${ids[0]}` : undefined} onClick={() => (ids[0] ? teleport(`card:${ids[0]}`, { focus: true }) : showTab('canvas'))} />
          ))}
          {loose.length > 0 && (
            <ChipRun>
              {loose.map((id) => (
                <span key={id} className="chat-tool-cell" data-anchor={`card:${id}`} onClick={(e) => e.stopPropagation()}>
                  <RefChip ref={`card:${id}`} compact workspace={ws} />
                </span>
              ))}
            </ChipRun>
          )}
        </>
      ),
    })
  }
  if (made.labels.length) {
    out.push({
      key: 'labels',
      label: 'Labels',
      onOpen: () => showTab('files'),
      chips: made.labels.map((l) => <LabelChip key={l} ws={ws} name={l} onClick={() => openLabel(ws, l)} />),
    })
  }
  const writer = opts.writer ?? null
  const docs = [...new Set([...made.docs, ...(opts.report ? [opts.report] : []), ...(writer ? [writer.doc] : [])])]
  if (docs.length) {
    out.push({
      key: 'report',
      label: 'Report',
      onOpen: () => showTab('report'),
      chips: (
        <>
          {docs.map((d) => (
            <DocChip key={d} ws={ws} slug={d} onClick={() => teleport(`report:${d}`)} />
          ))}
          {writer && writer.status !== 'done' && (
            <span className="chat-task-writer" data-status={writer.status} data-chat={writer.chat}>
              {writer.status === 'running' ? <Spinner size={10} label="writing" /> : <Mark kind="failed" label={writer.status} />}
              <span className="chat-task-writer-word">{writer.status === 'running' ? 'writing in' : writer.status === 'stopped' ? 'stopped in' : 'failed in'}</span>
              <ThreadChip id={writer.chat} />
            </span>
          )}
        </>
      ),
    })
  }
  return out
}

export interface AgentCardProps {
  ws: string
  chat: string
  role: string
  title: string
  ts?: string
  /** the log when the caller already reads it (the thread being shown), else the card reads it */
  log?: { meta: ChatMeta | null; records: readonly ChatRecord[]; error: string | null }
  /** open on its steps while it runs (the orientation in its own thread) */
  openWhileRunning?: boolean
  /** a document the run's work led to, listed under Report (the orientation's report pass) */
  report?: string | null
  /** the orientation's run the card stands for: 0 its first, then each follow-up; unset, its whole session */
  run?: number
  /** a stopped background session's Resume shows on the card; its own thread shows it at the end instead */
  resumeHere?: boolean
  /** a running session's Stop shows on the card; its own thread has it on the composer instead */
  stopHere?: boolean
  /** the analyst's instructions show as their own message above the card rather than inside it (the orientation in
   * its own thread) */
  briefAbove?: boolean
}

/** The browser's Stop of a session thimble started (the orientation, a writer, a check's run): its chat is interrupted
 * (backend agents.interrupt_route). A subagent of main, which only main can stop, is asked of main, and a toast says so;
 * a toast also says when the server runs no session for it or the request fails. Resolves true when the stop went
 * through or was asked of main, false otherwise. */
export function stopSession(ws: string, chat: string, role: string): Promise<boolean> {
  track('chat-interrupt', { target: `chat:${chat}`, detail: { role } })
  return api
    .interrupt(ws, chat)
    .then((r) => {
      if (r.stopped) return true
      if (r.asked === 'main') return (bus.emit('toast', { text: 'Asked main to stop it.' }), true)
      // the server answers `stopped: false` when it runs no session for this chat, which would otherwise look as if
      // Stop had worked
      return (bus.emit('toast', { text: 'Could not stop it: the server runs no session for it.', kind: 'error' }), false)
    })
    .catch((e: Error) => (bus.emit('toast', { text: `Could not stop it: ${e.message}`, kind: 'error' }), false))
}

/** The card of a session thimble started (the orientation, a writer, a check's run), or a subagent's chip. */
/** A background session whose process stopped (a crash, a kill, `claude stop`): what happened, and Resume, which
 * starts it again under its id with its conversation (backend agent_session.resume_chat). */
export function StoppedHold({ ws, chat, text }: { ws: string; chat: string; text: string }) {
  const [busy, setBusy] = useState(false)
  const resume = () => {
    setBusy(true)
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'resume-session' } })
    api
      .resumeSession(ws, chat)
      .catch((e: Error) => bus.emit('toast', { text: `Could not resume it: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="chat-holds">
      <div className="chat-hold chat-hold-stopped" data-kind="stopped" role="alert">
        <span>{text}</span>
        <Button variant="secondary" size="sm" busy={busy} onClick={resume}>
          Resume
        </Button>
      </div>
    </div>
  )
}

export function AgentCard(props: AgentCardProps) {
  if (!SESSION_ROLES.has(props.role)) return props.log ? <AgentChip {...props} log={props.log} /> : <AgentChipLive {...props} />
  return props.log ? <AgentCardView {...props} log={props.log} /> : <AgentCardLive {...props} />
}

function AgentCardLive(props: AgentCardProps) {
  const log = useAgentLog(props.ws, props.chat)
  return <AgentCardView {...props} log={log} />
}

function AgentChipLive(props: AgentCardProps) {
  const log = useAgentLog(props.ws, props.chat)
  return <AgentChip {...props} log={log} />
}

/**
 * A subagent or workflow agent as a chip: its name (model.agentChipName), its steps and duration, its state and the
 * chips of what it made. Open: the files its calls read (model.agentFiles), then its calls as plain-word steps.
 */
function AgentChip({ ws, chat, role, title, ts, log }: AgentCardProps & { log: NonNullable<AgentCardProps['log']> }) {
  const { meta, records, error } = log
  const rows = useMemo(() => foldRecords(records), [records])
  const status: ToolState = meta?.status ?? (error ? 'failed' : 'running')
  const running = status === 'running'
  const tools = useMemo(() => rows.filter((r) => r.kind === 'tool'), [rows])
  const steps = useMemo(() => toolSteps(tools, running, { plain: true }), [tools, running])
  const files = useMemo(() => agentFiles(rows, ws), [rows, ws])
  const proposals = useProposals(ws)
  const made = useMemo(() => withoutDropped(madeBy(rows), proposals), [rows, proposals])
  const [open, setOpen] = useState(false)
  const { name, target } = agentChipName(meta?.title || title)
  const took = running ? '' : durationText(meta?.created_at, meta?.ts_end)
  const metaText = [steps.length > 0 ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : '', took].filter(Boolean).join(' · ')
  const toggle = () => {
    if (!open) track('agent-row-expand', { target: `chat:${chat}`, detail: { role } })
    setOpen(!open)
  }
  return (
    <div className={`chat-msg chat-task chat-agent${open ? ' open' : ''}`} data-chat={chat} data-role={role} data-status={status} data-ts={ts}>
      <span className="chat-agent-head">
        <button type="button" className="chat-callchip chat-agent-chip" aria-expanded={open} onClick={toggle}>
          <span className="chat-agent-name">{name}</span>
          {target && <span className="chat-agent-target">{target}</span>}
          {metaText && <span className="chat-agent-meta">{metaText}</span>}
          <Icon name="chevron-right" size={10} className="chat-callchip-caret" />
        </button>
        {running ? <Spinner size={10} label="running" /> : status === 'done' ? <Mark kind="verified" label="done" className="chat-agent-mark" /> : <Mark kind="failed" label={status} className="chat-agent-mark" />}
        {madeSections(ws, made).map((sec) => (
          <span key={sec.key} className="chat-agent-made">
            {sec.chips}
          </span>
        ))}
      </span>
      {open && (
        <div className="chat-agent-body">
          {files.length > 0 && (
            <div className="chat-agent-files">
              <ChipRun>
                {files.map((f) =>
                  f.ref ? (
                    <span key={f.path} className="chat-tool-cell" data-anchor={f.ref}>
                      <RefChip ref={f.ref} compact workspace={ws} />
                    </span>
                  ) : (
                    <Chip key={f.path} kind="plain" className="chat-agent-file">
                      {f.path}
                    </Chip>
                  ),
                )}
              </ChipRun>
            </div>
          )}
          {steps.length > 0 && (
            <ol className="toolcard-steps chat-agent-steps">
              {steps.map((st, i) => (
                <li key={st.key ?? i} className={`toolcard-step toolcard-step-${st.state ?? 'done'}`}>
                  <StepGlyph state={st.state ?? 'done'} />
                  <span className="toolcard-step-text">{st.text}</span>
                </li>
              ))}
            </ol>
          )}
          {error && <div className="chat-error">{error}</div>}
          {status === 'failed' && <ReportProblemButton description={failureText(`${name}${target ? ` ${target}` : ''} failed.`, meta?.result)} focus={[chat]} className="chat-task-report" />}
        </div>
      )}
    </div>
  )
}

/** Whether the step an undo would revert belongs to run `run` of orientation `chat` (undo.py's `undo_run`), read again
 * after every change to a card or a document the stream announces; false while `want` is off. */
function useUndoRun(ws: string, chat: string, run: number | undefined, want: boolean): boolean {
  const [top, setTop] = useState<string | null>(null)
  useEffect(() => {
    if (!want) return
    let alive = true
    let timer: number | null = null
    const read = () =>
      undoApi
        .labels(ws)
        .then((l) => alive && setTop(l.undo_run ?? null))
        .catch(() => undefined)
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(read, REFETCH_DEBOUNCE_MS)
    }
    void read()
    const offCell = bus.on('cell', later)
    const offReport = bus.on('report', later)
    return () => {
      alive = false
      offCell()
      offReport()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, want])
  return want && top === `${chat}/${run}`
}

function AgentCardView({ ws, chat, role, title, ts, log, openWhileRunning = false, report, run, resumeHere = true, stopHere = true, briefAbove = false }: AgentCardProps & { log: NonNullable<AgentCardProps['log']> }) {
  const { meta, records, error } = log
  const all = useMemo(() => foldRecords(records), [records])
  // the run the card stands for, and whether a later one followed it (an earlier run has ended, whatever the chat's
  // status says of the run going on now)
  const runs = useMemo(() => (role === 'orient' && run != null ? orientRuns(all) : null), [all, role, run])
  const scoped = runs?.find((r) => r.k === run) ?? null
  const later = runs && scoped ? runs.find((r) => r.k > scoped.k) ?? null : null
  const rows = scoped ? scoped.rows : all
  const chatStatus: ToolState = meta?.status ?? (error ? 'failed' : 'running')
  // a follow-up's own record on the chat's meta (backend orientation.run_finished): its state, times and counts
  const record = run != null && run > 0 ? (meta?.followups ?? []).find((u) => u.run === run) : undefined
  const ended = record?.status === 'done' || record?.status === 'failed' || record?.status === 'stopped' ? (record.status as ToolState) : null
  const status: ToolState = ended ?? (later ? 'done' : chatStatus)
  const running = status === 'running'
  const followUp = !!scoped && scoped.k > 0
  const tools = useMemo(() => rows.filter((r) => r.kind === 'tool'), [rows])
  const { metas } = useContext(ThreadsContext)
  const own = SESSION_ROLES.has(role)
  const steps = useMemo(
    () => (own ? sessionSteps(rows, metas ?? new Map(), running, (id) => openThread(id, 'step')) : toolSteps(tools, running, { plain: true })),
    [own, rows, metas, tools, running, role],
  )
  const [stopping, setStopping] = useState(false)
  const stop = () => {
    setStopping(true)
    void stopSession(ws, chat, role).finally(() => setStopping(false))
  }
  // what holds its session besides its permission requests, which wait on the permission card above the composer
  const holds = running && own ? (
    <Holds alert={meta?.alert} rules={meta?.session_rules} restarted={restartedNow(meta, run, running)} onRetry={() => api.retrySession(ws, chat)} />
  ) : !running && own && resumeHere && meta?.alert?.kind === 'stopped' ? (
    <StoppedHold ws={ws} chat={chat} text={meta.alert.text} />
  ) : null
  // waiting for the analyst: on its own prompt, or on its critique's (chat/waiting.ts)
  const waitingFor = useMemo(() => {
    if (!running) return null
    const all = new Map<string, ChatMeta>(metas ?? [])
    if (meta) all.set(meta.id, meta) // the card's own read, which may be newer than the list's
    return waitingAt(chat, all.values())
  }, [running, chat, meta, metas])
  const waiting = !!waitingFor
  // the orientation's cards that name no group are in its deck (backend tools.default_group), so they count there; a
  // view it proposed that could not be built was dropped and is not among what it made
  const proposals = useProposals(ws)
  const made = useMemo(() => withoutDropped(role === 'orient' ? orientMade(madeBy(rows)) : madeBy(rows), proposals), [rows, role, proposals])
  const brief = useMemo(
    () => (followUp ? scoped!.messages.map(leadText).join('\n\n') : stripHarness(meta?.brief?.trim() || rows.find((r) => r.kind === 'user')?.text.trim() || '') || null),
    [followUp, scoped, meta?.brief, rows],
  )
  // the writer of its report pass, which its Report section carries (the card for a run, that run's; else the latest)
  const writer = useMemo(() => (role === 'orient' && metas ? orientWriterOf(orientWriters(metas.values()), chat, run) : null), [role, metas, chat, run])
  const [open, setOpen] = useState<boolean | null>(null)
  const shownOpen = open ?? (openWhileRunning && running)
  // how long it took: the whole session, or the run from its message to the next run's (or the session's end)
  const from = followUp ? (record?.started ?? scoped!.messages[0]?.ts) : meta?.created_at
  // an earlier run ended with its last call, which may be long before the next run's message
  const to = followUp && record?.ended ? record.ended : later ? (lastRowTs(rows) ?? later.messages[0]?.ts) : meta?.ts_end
  const took = running ? '' : durationText(from, to)
  const count = steps.length
  // what it changed: the server's counts from the run's undo steps when it kept them, else the log's calls
  const changed = followUp && !running ? (record && record.revised != null ? changeSummary(record) : followUpSummary(rows)) : ''
  const metaText = changed || [count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : '', took].filter(Boolean).join(' · ')
  const undoable = useUndoRun(ws, chat, run, followUp && !running && !!changed)
  const [undoing, setUndoing] = useState(false)
  const undo = () => {
    setUndoing(true)
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'undo-follow-up', run } })
    undoApi
      .undo(ws)
      .catch((e: Error) => bus.emit('toast', { text: `Could not undo it: ${e.message}`, kind: 'error' }))
      .finally(() => setUndoing(false))
  }
  const card = (
    <ToolCard
      className="chat-task"
      data-chat={chat}
      data-role={role}
      data-status={status}
      data-ts={ts}
      data-run={run}
      data-waiting={waiting || undefined}
      title={<span className="chat-task-title">{role === 'orient' ? 'Orientation' : taskTitle(meta?.title || title)}</span>}
      meta={metaText || undefined}
      state={status}
      lead={brief && !briefAbove ? <span className="chat-task-brief">{brief}</span> : undefined}
      steps={steps}
      body={error ? <div className="chat-error">{error}</div> : undefined}
      chips={
        own && running ? (
          <>
            {meta?.permission_mode ? <ModeSwitch ws={ws} chat={chat} meta={meta} /> : null}
            {holds}
          </>
        ) : holds ? (
          holds
        ) : undoable ? (
          <Button variant="ghost" size="sm" icon="undo" className="chat-task-undo" busy={undoing} onClick={undo}>
            Undo
          </Button>
        ) : status === 'failed' ? (
          <ReportProblemButton description={failureText(`${role === 'orient' ? 'The orientation' : taskTitle(meta?.title || title)} failed.`, meta?.result)} focus={[chat]} className="chat-task-report" />
        ) : undefined
      }
      stop={own && running && stopHere ? { onStop: stop, busy: stopping, className: 'chat-task-stop' } : undefined}
      open={shownOpen}
      onToggle={(o) => {
        if (o) track('agent-row-expand', { target: `chat:${chat}`, detail: { role } })
        setOpen(o)
      }}
      sections={madeSections(ws, made, { report, writer })}
    />
  )
  if (!briefAbove || !brief) return card
  return (
    <>
      <div className="chat-msg chat-user">
        <UserMessage className="chat-message">
          <RefText text={brief} workspace={ws} />
        </UserMessage>
      </div>
      {card}
    </>
  )
}

/** The report the orientation's report pass wrote, once it is generated after the orientation began; null before. */
function useOrientReport(ws: string, since: string | null | undefined): string | null {
  const [slug, setSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!since) return
    let alive = true
    // the frame route answers the document once it is written and a frame before, where the document's answers 404
    const look = () =>
      api
        .frame(ws, 'report')
        .then((d) => {
          const at = d.generated_at
          if (alive && at && !d.partial && !d.frame && Date.parse(at) >= Date.parse(since)) setSlug('report')
        })
        .catch(() => undefined)
    void look()
    const off = bus.on('report', (e) => e.slug === 'report' && (e.status === 'generated' || e.status === 'verified') && void look())
    return () => {
      alive = false
      off()
    }
  }, [ws, since])
  return slug
}

/** Whether the card stands for a session run that resumed after the server restarted under it (backend agent_session).
 * Pure. */
export function restartedNow(meta: Pick<ChatMeta, 'restarted' | 'run'> | null | undefined, run: number | undefined, running: boolean): boolean {
  const at = meta?.restarted
  return running && at != null && at.run === (run ?? meta?.run ?? 0)
}

/** Claude Code's API error line in a failed orientation's result, or null. Pure. */
export function failedApiLine(result: string | null | undefined): string | null {
  const text = result ?? ''
  const at = apiErrorAt(text)
  return at < 0 ? null : text.slice(at).trim()
}

/** The landing line of a failed orientation: why, in the error's own words on one line; an API error is shown as its
 * card instead (failedApiLine). Pure. */
export function failedLine(result: string | null | undefined): string {
  const why = failedApiLine(result) == null ? (result ?? '').split(/\s+/).filter(Boolean).join(' ') : ''
  if (!why) return 'Orientation failed.'
  return `Orientation failed: ${why.length > 400 ? `${why.slice(0, 399).trimEnd()}…` : why}${/[.!?…]$/.test(why) ? '' : '.'}`
}

/** Where the orientation finished, in main: what its first run left for review, then its card. A follow-up has a card of
 * its own where main asked for it. */
export function OrientLanding({ ws, chat }: { ws: string; chat: string }) {
  const log = useAgentLog(ws, chat)
  const runs = useMemo(() => orientRuns(foldRecords(log.records)), [log.records])
  const rows = runs[0].rows
  const proposals = useProposals(ws)
  const made = useMemo(() => withoutDropped(orientMade(madeBy(rows)), proposals), [rows, proposals])
  const report = useOrientReport(ws, log.meta?.created_at)
  const status = runs.length > 1 ? 'done' : (log.meta?.status ?? 'running')
  // the cards for review are the deck's, counted as the canvas counts them: a label's card is one of them
  const cards = deckCards(made) || madeCards(made)
  const list = reviewList({ views: made.views.length, cells: cards, labels: made.labels.length, report: !!report })
  const apiLine = status === 'failed' ? failedApiLine(log.meta?.result) : null
  return (
    <div className="chat-msg chat-landing" data-chat={chat}>
      <p className="chat-text chat-landing-line">
        {status === 'failed' ? failedLine(log.meta?.result) : status === 'stopped' ? 'Orientation stopped.' : status === 'running' ? 'Orientation is running.' : 'Orientation has finished.'}
        {status === 'failed' && <ReportProblemButton description={failureText('The orientation failed.', log.meta?.result)} focus={[chat]} className="chat-landing-report" />}
        {list && (
          <>
            {' Thimble has '}
            <ReviewCounts views={made.views.length} cells={cards} labels={made.labels.length} report={!!report} />
            {' for you to review.'}
          </>
        )}
      </p>
      {apiLine && <ApiErrorCard line={apiLine} />}
      <AgentCard ws={ws} chat={chat} role="orient" title="Orientation" log={log} report={report} run={0} />
    </div>
  )
}

/** The review line's counts, each in ink: `3 views`, `17 cards` and `a report`. */
function ReviewCounts({ views, cells, labels, report }: { views: number; cells: number; labels: number; report: boolean }) {
  const parts: string[] = []
  const n = (k: number, one: string, many: string) => k > 0 && parts.push(`${k} ${k === 1 ? one : many}`)
  n(views, 'view', 'views')
  n(cells, 'card', 'cards')
  n(labels, 'label', 'labels')
  if (report) parts.push('a draft report')
  return (
    <>
      {parts.map((p, i) => (
        <span key={p}>
          {i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}
          <b className="chat-landing-count">{p}</b>
        </span>
      ))}
    </>
  )
}
