// A subagent or workflow agent as a chip (AgentChip): its name, steps, duration, state and the chips of what it made;
// open, the files its calls read and its calls as plain-word steps (model.plainStep).
//
// A writer and a report check, each one of thimble's agents run as a subagent of the analyst's Claude Code session
// (backend subagents.py), are a tool-call card whose steps are that agent's own subagents (sessionSteps). Its header
// names the model and effort the run used. While it runs the card shows Stop (in its own thread the composer's stop
// square is its Stop instead, ChatPanel), which stops it through thimble's plugin. Its permission requests wait on the
// one permission card above the composer (PermissionCard), which the terminal answers. A run stopped by the analyst's
// quit says so, with Write again on a writer's card.
import { useContext, useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { RefChip } from '../components/RefChip'
import { Mark } from '../components/Marks'
import { Spinner } from '../components/Spinner'
import { ChipRun, StepGlyph, ToolCard, type ToolSection, type ToolState } from '../components/ToolCard'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { useProposals, withoutDropped } from '../lib/proposals'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { ChatMeta, ChatRecord } from '../lib/types'
import { waitingAt } from './waiting'
import { agentChipName, agentFiles, messageRuns, durationText, foldRecords, lastRowTs, madeBy, sessionSteps, stripHarness, taskTitle, toolSteps, type Made, type Row } from './model'
import { openThread, ThreadChip, ThreadsContext } from './Notes'
import { DocChip, GroupChip, LabelChip } from './SurfaceChips'
import { ViewChip } from './ViewChip'
import { failureText, ReportProblemButton } from '../shell/ProblemReport'
import { MAIN_ESC_LINE, STOP_DONE_LINE, isSubagent, mainStopFailedLine, runValues, stopFailedLine, stoppedLine, valuesText } from './subagent'

const REFETCH_DEBOUNCE_MS = 150
/** The roles of thimble's agents whose card lists their own subagents as steps and carries Stop: a writer and a report
 * check's run (backend subagents.TYPES). */
const SESSION_ROLES = new Set(['writer', 'check'])

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

/** The logs of the agent chats in `ids` (the writers and tickets that run), each folded, refetched on the stream's
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

/** The section rows of what a run made: one per surface it landed on. */
export function madeSections(ws: string, made: Made): ToolSection[] {
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
    // opens focus mode on the first card of the frame its first card sits in
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
      chips: made.labels.map((l) => <LabelChip key={l} name={l} onClick={() => openLabel(ws, l)} />),
    })
  }
  const docs = [...new Set(made.docs)]
  if (docs.length) {
    out.push({
      key: 'report',
      label: 'Report',
      onOpen: () => showTab('report'),
      chips: docs.map((d) => <DocChip key={d} ws={ws} slug={d} onClick={() => teleport(`report:${d}`)} />),
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
  /** open on its steps while it runs (a session in its own thread) */
  openWhileRunning?: boolean
  /** the run the card stands for: 0 its first, then each of a subagent's next messages, such as a round of a fix;
   * unset, its whole session */
  run?: number
  /** a subagent with a thread of its own: the card links to it */
  thread?: boolean
  /** a running session's Stop shows on the card; its own thread has it on the composer instead */
  stopHere?: boolean
}

/** The browser's Stop of one of thimble's agents (a writer, a check's run), of main's turn or of a side
 * thread's fork: its chat is interrupted (backend agents.interrupt_route), which stops it through thimble's plugin. A
 * Stop that found it ended already counts as done; one thimble could not pass on says how to stop it in the terminal,
 * for main with Esc (MAIN_ESC_LINE). The
 * analyst's own subagent of main, which only main can stop, is asked of main, and a toast says so. Resolves true when
 * the stop went through, was done already or was asked of main, false otherwise. */
export function stopSession(ws: string, chat: string, role: string): Promise<boolean> {
  track('chat-interrupt', { target: `chat:${chat}`, detail: { role } })
  const main = chat === 'main'
  const failed = (reason: string) => (main && !reason ? { text: MAIN_ESC_LINE } : { text: main ? mainStopFailedLine(reason) : stopFailedLine(reason), kind: 'error' as const })
  return api
    .interrupt(ws, chat)
    .then((r) => {
      if (r.stopped) return (r.done && bus.emit('toast', { text: STOP_DONE_LINE }), true)
      if (r.asked === 'main') return (bus.emit('toast', { text: 'Asked main to stop it.' }), true)
      if (r.kind) return (bus.emit('toast', failed(r.reason ?? '')), false)
      // the server answers `stopped: false` when it runs nothing for this chat, which would otherwise look as if Stop
      // had worked
      return (bus.emit('toast', { text: 'Could not stop it: thimble runs nothing for it.', kind: 'error' }), false)
    })
    .catch((e: Error) => (bus.emit('toast', failed(e.message)), false))
}

/** Write again on a writer that main's quit stopped: its request made anew as a click (subagents.again). */
function WriteAgain({ ws, request }: { ws: string; request: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="secondary"
      size="sm"
      className="chat-task-again"
      busy={busy}
      onClick={() => {
        setBusy(true)
        track('ui-click', { target: `request:${request}`, detail: { action: 'write-again' } })
        api
          .again(ws, request)
          .then((a) => (a.agentId ? undefined : bus.emit('toast', { text: `The writer didn't start: ${a.reason || a.kind}`, kind: 'error' })))
          .catch((e: Error) => bus.emit('toast', { text: `Could not write it again: ${e.message}`, kind: 'error' }))
          .finally(() => setBusy(false))
      }}
    >
      Write again
    </Button>
  )
}

/** What a subagent's card says under its steps, or null when it says nothing: why it stopped (`stopped`), and Write
 * again on a writer that main's quit stopped (`again`, its request). Nothing else says where the terminal shows the
 * agent, in any state. Pure. */
export function subagentNotes(meta: ChatMeta | null, running: boolean): { stopped: string; again: string | null } | null {
  if (!isSubagent(meta)) return null
  const n = {
    stopped: stoppedLine(meta),
    again: (meta?.role === 'writer' && meta.stopped_by === 'quit' && !running && meta.request) || null,
  }
  return n.stopped || n.again ? n : null
}

/** The notes of a subagent's card (subagentNotes), drawn; nothing when there are none. */
export function SubagentNotes({ ws, meta, running }: { ws: string; meta: ChatMeta | null; running: boolean }) {
  const n = subagentNotes(meta, running)
  if (!n) return null
  return (
    <div className="chat-sub-notes">
      {n.stopped && <p className="chat-sub-stopped" data-by={meta?.stopped_by ?? undefined}>{n.stopped}</p>}
      {n.again && <WriteAgain ws={ws} request={n.again} />}
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
function AgentChip({ ws, chat, role, title, ts, log, run, thread }: AgentCardProps & { log: NonNullable<AgentCardProps['log']> }) {
  const { meta, records, error } = log
  const all = useMemo(() => foldRecords(records), [records])
  const runs = useMemo(() => (run == null ? null : messageRuns(all)), [all, run])
  const rows = runs ? runs[run!] ?? [] : all
  // a run that a later one followed has ended, whatever the chat's status says of the run going on now
  const later = !!runs && runs.length > run! + 1
  const status: ToolState = later ? 'done' : meta?.status ?? (error ? 'failed' : 'running')
  const running = status === 'running'
  const tools = useMemo(() => rows.filter((r) => r.kind === 'tool'), [rows])
  const steps = useMemo(() => toolSteps(tools, running, { plain: true }), [tools, running])
  const files = useMemo(() => agentFiles(rows, ws), [rows, ws])
  const proposals = useProposals(ws)
  const made = useMemo(() => withoutDropped(madeBy(rows), proposals), [rows, proposals])
  const [open, setOpen] = useState(false)
  // a run's card keeps the name it started with; the chat's title is its latest run's
  const { name, target } = agentChipName((runs ? title : meta?.title) || title)
  const first = runs ? rows.find((r): r is Extract<Row, { kind: 'user' }> => r.kind === 'user')?.ts : undefined
  const took = running ? '' : durationText(first ?? meta?.created_at, later ? lastRowTs(rows) : meta?.ts_end)
  const metaText = [steps.length > 0 ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : '', took].filter(Boolean).join(' · ')
  const toggle = () => {
    if (!open) track('agent-row-expand', { target: `chat:${chat}`, detail: { role } })
    setOpen(!open)
  }
  return (
    <div className={`chat-msg chat-task chat-agent${open ? ' open' : ''}`} data-chat={chat} data-role={role} data-status={status} data-ts={ts}>
      <span className={`chat-agent-head${thread ? ' chat-agent-threaded' : ''}`}>
        <button type="button" className="chat-callchip chat-agent-chip" aria-expanded={open} onClick={toggle}>
          <span className="chat-agent-name">{name}</span>
          {target && <span className="chat-agent-target">{target}</span>}
          {metaText && <span className="chat-agent-meta">{metaText}</span>}
          <Icon name="chevron-right" size={10} className="chat-callchip-caret" />
        </button>
        {running ? <Spinner size={10} label="running" /> : status === 'done' ? <Mark kind="verified" label="done" className="chat-agent-mark" /> : <Mark kind="failed" label={status} className="chat-agent-mark" />}
        {thread && <ThreadChip id={chat} label="thread" />}
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

function AgentCardView({ ws, chat, role, title, ts, log, openWhileRunning = false, run, stopHere = true }: AgentCardProps & { log: NonNullable<AgentCardProps['log']> }) {
  const { meta, records, error } = log
  const rows = useMemo(() => foldRecords(records), [records])
  const status: ToolState = meta?.status ?? (error ? 'failed' : 'running')
  const running = status === 'running'
  const tools = useMemo(() => rows.filter((r) => r.kind === 'tool'), [rows])
  const { metas, main } = useContext(ThreadsContext)
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
  // what the card says of the agent besides its steps: why it stopped
  const notes = own && subagentNotes(meta, running) ? <SubagentNotes ws={ws} meta={meta} running={running} /> : null
  // waiting for the analyst on its own prompt (chat/waiting.ts)
  const waitingFor = useMemo(() => {
    if (!running) return null
    const all = new Map<string, ChatMeta>(metas ?? [])
    if (meta) all.set(meta.id, meta) // the card's own read, which may be newer than the list's
    return waitingAt(chat, all.values(), main)
  }, [running, chat, meta, metas, main])
  const waiting = !!waitingFor
  // a view proposal the analyst rejected is not among what it made
  const proposals = useProposals(ws)
  const made = useMemo(() => withoutDropped(madeBy(rows), proposals), [rows, proposals])
  const brief = useMemo(() => stripHarness(meta?.brief?.trim() || rows.find((r) => r.kind === 'user')?.text.trim() || '') || null, [meta?.brief, rows])
  const [open, setOpen] = useState<boolean | null>(null)
  const shownOpen = open ?? (openWhileRunning && running)
  const took = running ? '' : durationText(meta?.created_at, meta?.ts_end)
  const count = steps.length
  const values = valuesText(runValues(meta, run))
  const metaText = [values, count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : '', took].filter(Boolean).join(' · ')
  return (
    <ToolCard
      className="chat-task"
      data-chat={chat}
      data-role={role}
      data-status={status}
      data-ts={ts}
      data-waiting={waiting || undefined}
      title={<span className="chat-task-title">{taskTitle(meta?.title || title)}</span>}
      meta={metaText || undefined}
      state={status}
      flush
      lead={brief ? <span className="chat-task-brief">{brief}</span> : undefined}
      steps={steps}
      body={error ? <div className="chat-error">{error}</div> : undefined}
      chips={
        notes || status === 'failed' ? (
          <>
            {notes}
            {status === 'failed' && <ReportProblemButton description={failureText(`${taskTitle(meta?.title || title)} failed.`, meta?.result)} focus={[chat]} className="chat-task-report" />}
          </>
        ) : undefined
      }
      stop={own && running && stopHere ? { onStop: stop, busy: stopping, className: 'chat-task-stop' } : undefined}
      open={shownOpen}
      onToggle={(o) => {
        if (o) track('agent-row-expand', { target: `chat:${chat}`, detail: { role } })
        setOpen(o)
      }}
      sections={madeSections(ws, made)}
    />
  )
}
