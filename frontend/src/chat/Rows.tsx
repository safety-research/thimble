// The rows of a chat: the analyst's message as an accent tile, the assistant's markdown as plain text, and the work as
// tool-call cards. A raw call (Read, Grep, Glob, Bash) is one line with its state's glyph, tool and target; two or more
// in a row fold into one chip that names each tool and count (Bash 2 · Grep 1). In the orientation's thread every call
// is such a line carrying its `call:` ref, so it can be cited and, open, shows its whole stored output with numbered
// lines. Other runs of one kind of call are one card (Cards · 2 steps · 31s). Everything else is a quiet note with the
// chips of what it points at. Label runs in a row are one Label card, a step per label.
import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { CodeText } from '../components/Code'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { UserMessage } from '../components/Message'
import { RefChip, scrubIds } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { ChipRun, ToolCard, type ToolState } from '../components/ToolCard'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { callOutput, fetchCall, outputLines, setCallWords } from '../lib/calls'
import { isDropped, useProposals } from '../lib/proposals'
import { callRef, parseRef } from '../lib/refs'
import { CITED } from '../lib/tableCell'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import { chipIcon, chipPending, docSave, settleChip, settledWord, type Settled } from './chips'
import { ChatMarkdown, ChipContext, RefText } from './markdown'
import { API_ERROR_KIND, callLineText, callPieces, capacityNote, corpusRelative, durationText, groupState, groupTools, isRawCall, labelRunName, leadText, madeBy, QUIET_RE, runTools, stripHarness, toolDisplayName, toolMeta, toolSteps, toolSummary, underCorpus, type AgentRow as AgentRowT, type BranchRow, type CallsRow, type ChipRow as ChipRowT, type ErrorRow as ErrorRowT, type Row, type ToolGroup, type ToolRow as ToolRowT, waitText } from './model'
import { Note, ShotCard, ThreadChip, ThreadsContext } from './Notes'
import { AgentCard, OrientLanding, openLabel } from './AgentCard'
import { ApiErrorCard } from './ApiError'
import { DocChip, GroupChip, LabelChip } from './SurfaceChips'
import { ViewChip } from './ViewChip'

/** The working mark while a reply streams and no tool is pending: the spinner, the one thing that loops. */
export function Working() {
  return (
    <div className="chat-msg chat-working-row" aria-label="working">
      <Spinner label="working" />
    </div>
  )
}

export type RecordState = ToolState


/** A run of consecutive `view` chips: the views main or a subagent proposed, one note. */
export interface ViewsRow {
  kind: 'views'
  index: number
  chips: ChipRowT[]
}

/** A run of consecutive label runs (agent chats of role `labels`), one card with a step per label. */
export interface LabelRunsRow {
  kind: 'labelruns'
  index: number
  runs: AgentRowT[]
}

export type ShownRow = Exclude<Row, ToolRowT> | ToolGroup | CallsRow | BranchRow | ViewsRow | LabelRunsRow

const isLabelRun = (r: { kind: string; role?: string }): r is AgentRowT => r.kind === 'agent' && r.role === 'labels'

/** The rows as the transcript shows them: consecutive raw calls (model.isRawCall) as one run of chip lines, other calls
 * of one kind folded into one card, consecutive view chips into one note (duplicates dropped), and consecutive label
 * runs into one card. A view build's capacity wait joins the error row before it. A line saying the session shows no
 * activity holds only until the next row. With `each`, every call is a chip line of its own. Pure. */
export function shownRows(rows: readonly (Row | BranchRow)[], each = false): ShownRow[] {
  const out: ShownRow[] = []
  // a view a call of this chat proposed is a chip on that call's card, so its chip note would say it twice
  const proposedHere = new Set(madeBy(rows.filter((r): r is ToolRowT => r.kind === 'tool')).views)
  // a proposal's later chips (built, failed) are the first chip's state, which it reads for itself
  const viewsSeen = new Set<string>()
  // one card per label: its latest run
  const latestRun = new Map<string, number>()
  for (const r of rows) if (isLabelRun(r)) latestRun.set(labelRunName(r.title), r.index)
  for (const r of groupTools(rows as Row[]) as (Exclude<Row, ToolRowT> | ToolGroup | BranchRow)[]) {
    const before = out[out.length - 1]
    if (before?.kind === 'note' && QUIET_RE.test(before.text)) out.pop()
    if (r.kind === 'tools' && (each || r.tools.every((t) => isRawCall(t.name)))) {
      const last = out[out.length - 1]
      if (last && last.kind === 'calls') last.tools.push(...r.tools)
      else out.push({ kind: 'calls', index: r.index, tools: [...r.tools] })
      continue
    }
    if (r.kind === 'chip' && r.chip === 'view') {
      const key = r.ref || r.text
      if (proposedHere.has(r.text) || viewsSeen.has(key)) continue
      viewsSeen.add(key)
      const last = out[out.length - 1]
      if (last && last.kind === 'views') last.chips.push(r)
      else out.push({ kind: 'views', index: r.index, chips: [r] })
      continue
    }
    if (r.kind === 'note') {
      const wait = capacityNote(r.text)
      if (wait) {
        const last = out[out.length - 1]
        if (last?.kind === 'error' && last.errorKind === API_ERROR_KIND && last.wait == null) out[out.length - 1] = { ...last, wait: wait.wait }
        else out.push({ kind: 'error', index: r.index, message: wait.reason, errorKind: API_ERROR_KIND, wait: wait.wait })
        continue
      }
    }
    if (isLabelRun(r)) {
      if (latestRun.get(labelRunName(r.title)) !== r.index) continue
      const last = out[out.length - 1]
      if (last && last.kind === 'labelruns') last.runs.push(r)
      else out.push({ kind: 'labelruns', index: r.index, runs: [r] })
      continue
    }
    out.push(r)
  }
  return out
}

/** The call a followed `call:` ref opens (ChatPanel): its chip line opens, comes into view and is marked, with the cited
 * lines of its output marked; `seq` counts the follows, so a second follow of the same ref acts again. */
export interface CallFocus {
  ref: string
  line?: number
  endLine?: number
  seq: number
}
export const CallFocusContext = createContext<CallFocus | null>(null)

/**
 * The rows of one log level. `streaming` marks the last text row as still growing. `chat` is the log's chat id: every
 * message body carries `data-anchor="chat:<id>#<index>"`, so a ⌘-click starts a thread there. `calls` names the
 * orientation whose calls these rows hold: every call is then a chip line with its `call:` ref. `retry` names the error
 * row whose Retry sends the analyst's message again, and `note` its line.
 */
export function Rows({ rows, ws, chat, streaming = false, nested = false, calls, live = false, retry }: { rows: readonly (Row | BranchRow)[]; ws: string; chat?: string; streaming?: boolean; nested?: boolean; calls?: string; live?: boolean; retry?: ErrorRetry }) {
  const lastText = streaming ? [...rows].reverse().find((r): r is Extract<Row, { kind: 'text' }> => r.kind === 'text') : undefined
  const lastRow = rows[rows.length - 1]
  const toolPending = lastRow?.kind === 'tool' && !lastRow.result
  const anchorOf = (index: number) => (chat ? `chat:${chat}#${index}` : undefined)
  const shown = shownRows(rows, !!calls)
  return (
    <ChipContext.Provider value={{ workspace: ws, broken: EMPTY, anchor: true }}>
      {shown.map((r, i) => {
        switch (r.kind) {
          case 'user':
            if (r.by === 'extension') return <ExtensionLead key={r.index} name={r.extension ?? ''} text={r.text} ws={ws} />
            return (
              <div key={r.index} className="chat-msg chat-user" data-event={r.event}>
                {r.by === 'main' && <Note className="chat-origin" text="From" chips={<ThreadChip id="main" />} />}
                {byLabel(r.by, chat, r.tray) && <Note className="chat-origin chat-by" data-by={r.by} text={byLabel(r.by, chat, r.tray)!} />}
                <UserMessage className="chat-message" data-anchor={anchorOf(r.index)} data-anchor-text={chat ? r.text : undefined} data-by={r.by}>
                  <RefText text={stripHarness(r.text)} workspace={ws} />
                </UserMessage>
              </div>
            )
          case 'text':
            return (
              <div key={r.index} className={`chat-msg chat-assistant${nested ? ' chat-nested' : ''}`}>
                <div className="chat-text" data-anchor={anchorOf(r.index)} data-anchor-text={chat ? r.text : undefined}>
                  <ChatMarkdown text={r.text} streaming={r === lastText} />
                </div>
              </div>
            )
          case 'tools':
            return <ToolGroupCard key={r.index} group={r} ws={ws} pending={streaming && i === shown.length - 1} />
          case 'calls':
            return <CallLines key={r.index} tools={r.tools} ws={ws} pending={live || (streaming && i === shown.length - 1)} calls={calls} />
          case 'chip':
            return <ChipRow key={r.index} item={r} ws={ws} />
          case 'views':
            return <ViewsNote key={r.index} chips={r.chips} ws={ws} />
          case 'labelruns':
            return <LabelRunsCard key={r.index} runs={r.runs} ws={ws} />
          case 'agent':
            // a follow-up of the orientation is its card for that run, the message as its lead; the first run is a note
            if (r.role === 'orient' && (r.run ?? 0) > 0) return <AgentCard key={r.index} ws={ws} chat={r.chat} role="orient" title="Orientation" ts={r.ts} run={r.run} />
            if (r.role === 'orient') return <Note key={r.index} className="chat-agent-note" data-chat={r.chat} text="Orientation started in" chips={<ThreadChip id={r.chat} />} />
            if (r.role === 'writer') return <Note key={r.index} className="chat-agent-note" data-chat={r.chat} text="Writing started in" chips={<ThreadChip id={r.chat} />} />
            if (r.role === 'dev') return <Note key={r.index} className="chat-agent-note" data-chat={r.chat} text={devStarted(r)} chips={<ThreadChip id={r.chat} />} />
            return <AgentCard key={r.index} ws={ws} chat={r.chat} role={r.role} title={r.title} ts={r.ts} />
          case 'branch':
            return (
              <Note
                key={`branch:${r.chat}`}
                className="chat-branch"
                data-chat={r.chat}
                text="You asked about"
                chips={
                  <>
                    {r.anchors.slice(0, 3).map((a, k) => (
                      <RefChip key={`${a}:${k}`} ref={a} compact workspace={ws} />
                    ))}
                    {r.anchors.length > 3 && <Chip kind="value">+{r.anchors.length - 3}</Chip>}
                    <ThreadChip id={r.chat} />
                  </>
                }
              />
            )
          case 'note':
            return <Note key={r.index} className="chat-stage" text={r.text} />
          case 'shot':
            return <ShotCard key={r.index} ticket={r.ticket} name={r.name} phase={r.phase} note={r.note} />
          case 'error':
            return <ErrorRow key={r.index} item={r} retry={retry && retry.index === r.index ? retry : undefined} />
        }
      })}
      {streaming && !toolPending && <Working />}
    </ChipContext.Provider>
  )
}

const EMPTY: ReadonlySet<string> = new Set()

/** Main's note for a dev chat that started: a view's build (`view`, on the backend's agent row), else a code ticket.
 * Pure. */
export function devStarted(r: { view?: string }): string {
  return r.view ? 'View build started in' : 'Dev ticket started'
}

/** Where a message to one of thimble's agents came from, in its thread: typed in Claude Code's agent tray (`terminal`
 * with `tray`, the record's origin `human`) or sent from thimble's browser (`browser`); none for a prompt main's call
 * sent (`terminal` alone), and none in main, whose own messages are the analyst's. Pure. */
export function byLabel(by: string | undefined, chat: string | undefined, tray?: boolean): string | null {
  if (!chat || chat === 'main') return null
  if (by === 'terminal') return tray ? 'typed in the agent tray' : null
  if (by === 'browser') return 'sent from thimble'
  return null
}

// the input fields that hold code, each with the language it is coloured in (components/Code.tsx): a card's code runs
// in the Python kernel, a command in the shell
const CODE_KEYS = new Map([
  ['code', 'python'],
  ['command', 'bash'],
  ['sql', 'sql'],
  ['html', 'xml'],
  ['data_md', 'markdown'],
])
const HIDDEN_KEYS = new Set(['id', 'tool_use_id'])

interface InputRow {
  key: string
  kind: 'text' | 'code' | 'json'
  value: string
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return String(v)
  }
}

/** Whether the head's summary already prints this field, so the open body need not repeat it. */
function inSummary(row: InputRow, summary: string): boolean {
  if (!summary || !row.value) return false
  if (row.kind === 'code') return row.value.trim() === summary
  if (row.kind !== 'text') return false
  const one = row.value.replace(/\s+/g, ' ').trim()
  return one.length > 0 && (summary.includes(one) || summary.includes(corpusRelative(one)))
}

/**
 * The rows an open tool row shows for its input: strings as text or code, anything else as JSON. A string field the
 * head's `summary` already shows (the pattern of a search, the path of a read) is left out.
 */
export function inputRows(input: unknown, summary = ''): InputRow[] {
  if (input == null) return []
  if (typeof input === 'string') return input.trim() === summary ? [] : [{ key: '', kind: 'text', value: input }]
  if (typeof input !== 'object' || Array.isArray(input)) return [{ key: '', kind: 'json', value: scrubIds(safeJson(input)) }]
  const out: InputRow[] = []
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (HIDDEN_KEYS.has(key) || v == null || v === '') continue
    let row: InputRow
    if (typeof v === 'string') row = { key, kind: CODE_KEYS.has(key) ? 'code' : 'text', value: v }
    else if (typeof v === 'number' || typeof v === 'boolean') row = { key, kind: 'text', value: String(v) }
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) row = { key, kind: 'text', value: v.map(String).join(', ') }
    else row = { key, kind: 'json', value: scrubIds(safeJson(v)) }
    if ((typeof v === 'string' || Array.isArray(v)) && inSummary(row, summary)) continue
    out.push(row)
  }
  return out
}

/** A tool result as the analyst reads it: the `card:`/`notebook:` header lines gone, ids scrubbed. */
export function resultText(summary: string | undefined): string {
  if (!summary) return ''
  const lines = summary.split('\n')
  let i = 0
  while (i < lines.length && /^(card|cell|notebook):[A-Za-z0-9_-]+\s*$/.test(lines[i].trim())) i++
  return scrubIds(lines.slice(i).join('\n'))
}

/** What an open call shows: its input fields the head does not already print, and its result as text unless it made a
 * card (the chip is the result) or it failed (the error is). Pure. */
function callParts(tool: ToolRowT, summary: string): { rows: InputRow[]; result: string; failed: boolean } {
  const failed = !!tool.result?.is_error
  return { rows: inputRows(tool.input, summary), result: tool.result && (!tool.result.cell_id || failed) ? resultText(tool.result.summary) : '', failed }
}

/** The body an open single call shows (callParts); nothing when it has nothing more to say. A call of an orientation
 * (`callRef`) shows its whole stored output in place of the log's start of it: the spinner while it is read, and the
 * log's own text where the store has no copy. A failed call shows its error before its input. */
function CallBody({ tool, ws, summary, stored = null, callRef: ref = null, focus = null, running = false }: { tool: ToolRowT; ws: string; summary: string; stored?: Stored | null; callRef?: string | null; focus?: CallFocus | null; running?: boolean }) {
  const { rows, result, failed } = callParts(tool, summary)
  const whole = ref && stored?.state === 'ok' ? stored : null
  const loading = !!ref && (stored == null || stored.state === 'loading')
  if (!rows.length && !result && !ref) return null
  const fields = rows.length > 0 && (
    <div className="chat-tool-fields">
      {rows.map((r, i) => (
        <div key={`${r.key}:${i}`} className={`chat-tool-field chat-tool-field-${r.kind}`}>
          {r.key && <span className="chat-tool-key label">{r.key.replace(/_/g, ' ')}</span>}
          {r.kind === 'text' ? (
            <span className="chat-tool-value">
              <RefText text={r.value} workspace={ws} />
            </span>
          ) : (
            <pre className="chat-tool-pre">
              <CodeText text={r.value} lang={r.kind === 'json' ? 'json' : CODE_KEYS.get(r.key)} />
            </pre>
          )}
        </div>
      ))}
    </div>
  )
  const output =
    whole && ref ? (
      running && !whole.text ? null : <CallOutput text={whole.text} callRef={ref} failed={whole.failed || failed} focus={focus} />
    ) : loading ? (
      <div className="chat-call-loading">
        <Spinner size={10} label="Reading the call's output" />
      </div>
    ) : (
      result && (
        <>
          {failed && <div className="chat-tool-label label">Error</div>}
          <div className={`chat-tool-result${failed ? ' chat-tool-result-error' : ''}`}>
            <RefText text={result} workspace={ws} />
          </div>
        </>
      )
    )
  const errorFirst = failed || !!whole?.failed
  return (
    <>
      {errorFirst ? output : fields}
      {errorFirst ? fields : output}
    </>
  )
}

/** A run of calls of one kind as one tool-call card. One call's card names what it was about in the meta and opens to
 * its input and result as well as its step; what the calls made are chips under the head: the cards, the views
 * proposed, the labels applied. */
export function ToolGroupCard({ group, ws, pending }: { group: ToolGroup; ws: string; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = group.tools
  const single = tools.length === 1 ? tools[0] : null
  const made = madeBy(tools)
  const cells = made.cells.map((c) => c.id)
  const summary = single ? toolSummary(single.name, single.input, ws) : ''
  const madeSome = cells.length + made.views.length + made.labels.length > 0
  const meta = single && !madeSome && summary ? summary : toolMeta(tools)
  const state = groupState(tools, pending)
  const body = open && single ? <CallBody tool={single} ws={ws} summary={summary} /> : null
  const chips = [
    ...cells.map((id) => (
      <span key={`card:${id}`} className="chat-tool-cell" data-anchor={`card:${id}`} onClick={(e) => e.stopPropagation()}>
        <RefChip ref={`card:${id}`} compact workspace={ws} />
      </span>
    )),
    ...made.views.map((v) => <ViewChip key={`view:${v}`} ws={ws} slug={made.viewSlugs?.[v]} name={v} />),
    ...made.labels.map((l) => <LabelChip key={`label:${l}`} ws={ws} name={l} onClick={(e) => (e.stopPropagation(), openLabel(ws, l))} />),
  ]
  return (
    <ToolCard
      className="chat-tool"
      data-tool={single ? toolDisplayName(single.name) : group.name}
      data-cells={cells.length || undefined}
      title={<span className="chat-tool-name">{group.name}</span>}
      meta={meta}
      state={state}
      open={open}
      onToggle={setOpen}
      steps={toolSteps(tools, pending)}
      body={body}
      chips={chips.length > 0 ? <ChipRun>{chips}</ChipRun> : undefined}
    />
  )
}

export { underCorpus }

/** A run of calls: two or more raw calls in a row as one folded chip (CallRun), every other call a line of its own; in
 * the orientation's thread (`calls`), calls of every tool fold together (model.callPieces). */
function CallLines({ tools, ws, pending, calls }: { tools: readonly ToolRowT[]; ws: string; pending: boolean; calls?: string }) {
  return (
    <div className="chat-msg chat-calls">
      {callPieces(tools, !!calls).map((p) =>
        p.kind === 'run' ? (
          <CallRun key={p.tools[0].id} tools={p.tools} ws={ws} pending={pending} calls={calls} />
        ) : (
          <CallLine key={p.tool.id} tool={p.tool} ws={ws} running={pending && !p.tool.result} calls={calls} />
        ),
      )}
    </div>
  )
}

/**
 * Calls in a row as one call chip naming each tool and count (model.runTools), a spinner while one runs, and the
 * failed count, which opens those calls alone. A click opens every line (CallLine). A followed `call:` ref into the run
 * opens it.
 */
function CallRun({ tools, ws, pending, calls }: { tools: readonly ToolRowT[]; ws: string; pending: boolean; calls?: string }) {
  const focus = useContext(CallFocusContext)
  const holds = !!focus && !!calls && tools.some((t) => t.n != null && callRef(calls, t.n) === focus.ref)
  const [open, setOpen] = useState<'all' | 'failed' | null>(null)
  useEffect(() => {
    if (holds) setOpen('all')
  }, [holds, focus?.seq])
  const running = pending && tools.some((t) => !t.result)
  const failed = tools.filter((t) => t.result?.is_error)
  const named = runTools(tools)
  const toggle = (what: 'all' | 'failed') => setOpen((o) => (o === what ? null : what))
  const shown = open === 'all' ? tools : open === 'failed' ? failed : []
  return (
    <div className={`chat-callrun${open ? ` open open-${open}` : ''}`} data-calls={tools.length} data-state={running ? 'running' : failed.length ? 'failed' : undefined}>
      <span className="chat-callrun-head">
        <button type="button" className="chat-callchip chat-callrun-chip" aria-expanded={open === 'all'} onClick={() => toggle('all')}>
          <span className="chat-callrun-tools">
            {named.tools.map((t, i) => (
              <span key={t.name} className="chat-callrun-tool">
                {i > 0 && <span className="chat-callrun-sep">·</span>}
                <span className="chat-callrun-name">{t.name}</span>
                <span className="chat-callrun-n">{t.n}</span>
              </span>
            ))}
            {named.more > 0 && <span className="chat-callrun-more">{`+${named.more}`}</span>}
          </span>
          <Icon name="chevron-right" size={10} className="chat-callchip-caret" />
        </button>
        {running && <Spinner size={10} label="running" />}
        {failed.length > 0 && (
          <button type="button" className="chat-callchip chat-callrun-failed" aria-expanded={open === 'failed'} onClick={() => toggle('failed')}>
            <Mark kind="failed" className="chat-call-mark" aria-hidden="true" />
            <span className="chat-callrun-failed-text">{`${failed.length} failed`}</span>
            <Icon name="chevron-right" size={10} className="chat-callchip-caret" />
          </button>
        )}
      </span>
      {shown.length > 0 && (
        <div className="chat-callrun-lines">
          {shown.map((t) => (
            <CallLine key={`${open}:${t.id}`} tool={t} ws={ws} running={pending && !t.result} calls={calls} startOpen={open === 'failed'} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The lines an open call shows at first; the rest wait behind Show all, since a stored output may run to 2 MB. */
export const CALL_LINES_SHOWN = 400

/** What an open call's store read gives: nothing asked yet, the read under way, the whole output, or no stored copy
 * (the log's own start of the result stands in). */
type Stored = { state: 'loading' } | { state: 'ok'; text: string; failed: boolean } | { state: 'missing' }

/** Call `n` of orientation `chat` from the server's store while `want`, read again once the call has finished. */
function useStoredCall(ws: string, chat: string | undefined, n: number | undefined, want: boolean, done: boolean): Stored | null {
  const [stored, setStored] = useState<Stored | null>(null)
  useEffect(() => {
    if (!want || !chat || n == null) return
    let alive = true
    setStored((cur) => (cur?.state === 'ok' ? cur : { state: 'loading' }))
    fetchCall(ws, chat, n)
      .then((c) => alive && setStored({ state: 'ok', text: callOutput(c), failed: !!c.is_error }))
      .catch(() => alive && setStored({ state: 'missing' }))
    return () => {
      alive = false
    }
  }, [ws, chat, n, want, done])
  return stored
}

/** The thimble tools whose target is one or more refs (a card, a passage of the report): their chip line names the
 * tool alone and each ref follows it as its chip, which names a card by its name, never its id. */
const REF_TARGET_TOOLS = new Set(['read_ref', 'screenshot', 'edit_card', 'delete_card', 'edit_document', 'add_comment'])

/** The refs a call's target names, when it is a thimble call whose target is refs alone; null otherwise. Pure. */
export function targetRefs(name: string, summary: string): string[] | null {
  if (!REF_TARGET_TOOLS.has(toolDisplayName(name))) return null
  // a card named by its id alone, as edit_card and delete_card take it, is that card's ref
  const parts = summary
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/^[0-9a-f]{8}$/.test(x) ? `card:${x}` : x))
  return parts.length && parts.every((x) => x.includes(':') && parseRef(x) != null) ? parts : null
}

/** The chips of what a thimble call made, after its chip line: the card, the view proposed, the label applied; and the
 * refs its target named that are not among them (targetRefs). */
function madeChips(tool: ToolRowT, ws: string, refs: readonly string[] = []) {
  const made = madeBy([tool])
  const madeIds = new Set(made.cells.map((c) => `card:${c.id}`))
  return [
    ...refs
      .map((r) => r.replace(/^cell:/, 'card:'))
      .filter((r) => !madeIds.has(r.split(/[#@]/)[0]))
      .map((r) => (
        <span key={`ref:${r}`} className="chat-tool-cell" data-anchor={r} onClick={(e) => e.stopPropagation()}>
          <RefChip ref={r} compact workspace={ws} />
        </span>
      )),
    ...made.cells.map((c) => (
      <span key={`card:${c.id}`} className="chat-tool-cell" data-anchor={`card:${c.id}`} onClick={(e) => e.stopPropagation()}>
        <RefChip ref={`card:${c.id}`} compact workspace={ws} />
      </span>
    )),
    ...made.views.map((v) => <ViewChip key={`view:${v}`} ws={ws} slug={made.viewSlugs?.[v]} name={v} />),
    ...made.labels.map((l) => <LabelChip key={`label:${l}`} ws={ws} name={l} onClick={(e) => (e.stopPropagation(), openLabel(ws, l))} />),
  ]
}

/**
 * One call as Claude Code prints its line: its state's glyph, the tool and its target in mono, and the chips of what a
 * thimble call made. A click opens the call's other input fields and its result. An orientation's call carries its ref
 * `call:<chat>/<n>` as its anchor; open, it shows the whole stored output, each line anchored. A followed ref opens it,
 * scrolls it into view with a flash and marks the cited lines.
 */
export function CallLine({ tool, ws, running, calls, startOpen = false }: { tool: ToolRowT; ws: string; running: boolean; calls?: string; startOpen?: boolean }) {
  const ref = calls && tool.n != null ? callRef(calls, tool.n) : null
  const focus = useContext(CallFocusContext)
  const focused = ref && focus?.ref === ref ? focus : null
  const [open, setOpen] = useState(startOpen)
  const rowEl = useRef<HTMLDivElement>(null)
  const name = toolDisplayName(tool.name)
  const summary = toolSummary(tool.name, tool.input, ws)
  const refs = targetRefs(tool.name, summary)
  const target = refs ? '' : underCorpus(summary, ws)
  const { rows, result, failed } = callParts(tool, summary)
  const stored = useStoredCall(ws, calls, tool.n, !!ref && open, !!tool.result)
  const opens = !!ref || rows.length > 0 || !!result
  const made = madeChips(tool, ws, refs ?? [])
  const lineText = callLineText(tool.name, tool.input, ws)
  useEffect(() => {
    if (ref) setCallWords(calls!, tool.n!, tool.name, tool.input)
  }, [ref, calls, tool.n, tool.name, tool.input])
  // a followed ref opens the call; once its output has come (or is known to be missing) the call comes into view,
  // flashes, and its body scrolls to the first cited line
  useEffect(() => {
    if (focused) setOpen(true)
  }, [focused?.seq])
  const shownFor = useRef(-1)
  const ready = stored?.state === 'ok' || stored?.state === 'missing'
  useEffect(() => {
    const el = rowEl.current
    if (!focused || !el || !open || shownFor.current === focused.seq || (ref && !ready)) return
    shownFor.current = focused.seq
    const first = focused.line != null ? el.querySelector<HTMLElement>(`[data-line="${focused.line}"]`) : null
    const body = el.querySelector<HTMLElement>('.chat-call-body')
    if (first && body) body.scrollTop = Math.max(0, first.offsetTop - body.clientHeight / 3)
    el.scrollIntoView({ block: 'center' })
    el.classList.add('anchor-flash')
    const t = window.setTimeout(() => el.classList.remove('anchor-flash'), 1600)
    return () => window.clearTimeout(t)
  }, [focused, open, ready, ref])
  const onDragStart = (e: DragEvent<HTMLElement>) => {
    if (!ref) return
    e.dataTransfer.setData('text/plain', `[[${ref}]]`)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const state = running ? 'running' : failed ? 'failed' : tool.result?.not_run ? 'skipped' : tool.result ? 'done' : undefined
  const words = (
    <>
      <span className="chat-call-tool">{name}</span>
      {target && (
        <>
          {' '}
          <span className="chat-call-target">{target}</span>
        </>
      )}
    </>
  )
  return (
    <div ref={rowEl} className={`chat-call${open && opens ? ' open' : ''}`} data-tool={name} data-state={state} data-call={tool.n} data-anchor={ref ?? undefined} data-anchor-text={ref ? lineText : undefined}>
      <span className="chat-call-head">
        <span className="chat-call-state" aria-hidden={running || failed ? undefined : true}>
          {running ? <Spinner size={10} label="running" /> : failed ? <Mark kind="failed" label="failed" className="chat-call-mark" /> : state === 'skipped' ? '–' : <span className="chat-call-dot" />}
        </span>
        {opens ? (
          <button type="button" className="chat-call-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)} draggable={ref ? true : undefined} onDragStart={ref ? onDragStart : undefined}>
            {words}
          </button>
        ) : (
          <span className="chat-call-chip" draggable={ref ? true : undefined} onDragStart={ref ? onDragStart : undefined}>
            {words}
          </span>
        )}
        {made}
      </span>
      {open && opens && (
        <div className="chat-call-body">
          <CallBody tool={tool} ws={ws} summary={summary} stored={ref ? stored : null} callRef={ref} focus={focused} running={running} />
        </div>
      )}
    </div>
  )
}

/** A call's whole output, each line numbered and anchored as `call:<chat>/<n>#L<i>`, the cited lines marked; the first
 * CALL_LINES_SHOWN lines, the rest behind Show all (all of them at once when a cited line lies past them). */
function CallOutput({ text, callRef: ref, failed, focus }: { text: string; callRef: string; failed: boolean; focus: CallFocus | null }) {
  const lines = outputLines(text)
  const [all, setAll] = useState(false)
  const lo = focus?.line
  const hi = focus?.endLine ?? focus?.line
  const shown = all || lines.length <= CALL_LINES_SHOWN || (hi ?? 0) > CALL_LINES_SHOWN ? lines : lines.slice(0, CALL_LINES_SHOWN)
  if (!lines.length) return <div className="chat-call-none">No output</div>
  return (
    <>
      {failed && <div className="chat-tool-label label">Error</div>}
      <ol className={`chat-call-out${failed ? ' chat-call-out-error' : ''}`}>
        {shown.map((l, i) => {
          const n = i + 1
          const cited = lo != null && hi != null && n >= lo && n <= hi
          return (
            <li key={n} className={cited ? `chat-call-line ${CITED}` : 'chat-call-line'} data-line={n} data-anchor={`${ref}#L${n}`} data-anchor-text={l}>
              <span className="chat-call-ln" aria-hidden="true">
                {n}
              </span>
              <span className="chat-call-lt">{l || '\u00a0'}</span>
            </li>
          )
        })}
      </ol>
      {shown.length < lines.length && (
        <button type="button" className="chat-call-more" onClick={() => setAll(true)}>
          {`Show all ${lines.length.toLocaleString()} lines`}
        </button>
      )}
    </>
  )
}

/** A dev ticket's end in main, in a few words: applied, stopped, or failed (a change to a view that failed puts the view
 * back as it was); the thread its chip opens has the reason. Other chips keep their text. Pure. */
export function ticketChipText(item: Pick<ChipRowT, 'status' | 'text' | 'ref'>): string {
  switch (item.status) {
    case 'applied':
      return 'Dev ticket applied'
    case 'stopped':
      return 'Dev ticket stopped'
    case 'failed':
    case 'needs manual merge':
    case 'rolled back':
      return item.ref?.startsWith('view:') ? 'The change to the view failed, so it is as it was' : item.status === 'rolled back' ? 'Dev ticket rolled back' : 'Dev ticket failed'
    default:
      return item.text
  }
}

/**
 * An act with no reply. A `say` reads as body text. The orientation's end is the line of what it left to review and its
 * card. A chip that names a thread is a note with the thread's chip; one that points at a surface is a chip that goes
 * there (SurfaceChips), with a spinner while its work is in flight; anything else is a note.
 */
/** The words of a follow-up that did not reach the orientation (orient_session.not_passed_on). */
export const notPassedOn = (reason: string): string => `Your message was not passed on${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}.`

/** Send again on a follow-up that was not passed on: the same message to the orientation, as a click. */
function SendAgain({ ws, text }: { ws: string; text: string }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  if (sent) return <span className="chat-chip-settled">sent</span>
  return (
    <Button
      variant="secondary"
      size="sm"
      className="chat-send-again"
      busy={busy}
      onClick={() => {
        setBusy(true)
        track('ui-click', { target: 'chat:orient', detail: { action: 'send-again' } })
        api
          .messageOrientation(ws, text)
          .then(() => setSent(true))
          .catch((e: Error) => bus.emit('toast', { text: notPassedOn(e.message.replace(/^\d{3}\s+/, '')), kind: 'error' }))
          .finally(() => setBusy(false))
      }}
    >
      Send again
    </Button>
  )
}

export function ChipRow({ item, ws }: { item: ChipRowT; ws: string }) {
  const settled = useChipSettled(ws, item)
  if (item.chip === 'not_passed_on') {
    return (
      <div className="chat-msg chat-not-passed" data-chip="not_passed_on" role="status">
        <Note className="chat-chip-row" text={notPassedOn(item.text)} chips={item.message ? <SendAgain ws={ws} text={item.message} /> : undefined} />
        {item.message && <p className="chat-not-passed-text">{item.message}</p>}
      </div>
    )
  }
  if (item.chip === 'follow_up_ran_on') return <Note className="chat-chip-row chat-ran-on" data-chip="follow_up_ran_on" text={item.text} />
  if (item.chip === 'say') {
    return (
      <div className="chat-msg chat-assistant chat-say" data-chip="say">
        <div className="chat-text">
          <RefText text={item.text} workspace={ws} cite />
        </div>
      </div>
    )
  }
  if (item.chip === 'artifact' && item.chat) return <OrientLanding ws={ws} chat={item.chat} />
  if (item.chip === 'ticket' && item.chat) {
    // the ticket's start is the dev chat's own row; its end names the thread that holds the whole run, where a failure's
    // reason and its Retry are (chat/TicketStatus)
    if (item.status === 'started') return null
    const text = ticketChipText(item)
    return <Note className="chat-chip-row" data-chip="ticket" data-status={item.status} text={text} chips={<ThreadChip id={item.chat} />} />
  }
  if (item.chip === 'thread' && item.chat) return <Note className="chat-chip-row" data-chip="thread" text={item.text} chips={<ThreadChip id={item.chat} />} />
  const pending = chipPending(item.status) && settled == null
  const opens = !!item.ref && item.chip !== 'ticket'
  const status = pending ? 'pending' : settled ?? item.status
  const go = () => {
    track('chip-teleport', { target: item.ref, detail: { kind: item.chip } })
    // a canvas group's chip opens focus mode on the frame's first card (Canvas)
    teleport(item.ref!, item.ref!.startsWith('group:') ? { focus: true } : {})
  }
  const target = opens ? parseRef(item.ref!) : null
  const save = opens ? docSave(item.chip, item.ref, item.text, item.generation) : null
  if (save && target?.kind === 'report') {
    return (
      <Note
        className="chat-chip-row chat-doc-save"
        data-chip={item.chip}
        data-status={status ?? undefined}
        data-verb={save.verb}
        spin={pending}
        text={save.verb}
        chips={
          <span className="chat-chip" data-ref={item.ref} title={save.generation ? `generation ${save.generation}` : undefined}>
            <DocChip ws={ws} slug={target.slug} className="chat-chip-link" onClick={go} />
            {settled === 'failed' && <span className="chat-chip-settled chat-chip-settled-failed">{settledWord(settled)}</span>}
          </span>
        }
      />
    )
  }
  return (
    <Note
      className="chat-chip-row"
      data-chip={item.chip}
      data-status={status ?? undefined}
      spin={opens && pending}
      text={opens ? undefined : item.text}
      chips={
        opens ? (
          <span className="chat-chip" data-ref={item.ref}>
            {target?.kind === 'report' ? (
              <DocChip ws={ws} slug={target.slug} className="chat-chip-link" onClick={go}>
                {item.text}
              </DocChip>
            ) : target?.kind === 'group' ? (
              <GroupChip name={item.text} className="chat-chip-link" onClick={go} />
            ) : (
              <Chip kind="ref" tone="accent" icon={chipIcon(item.chip, item.ref)} face="sans" className="chat-chip-link" onClick={go}>
                {item.text}
              </Chip>
            )}
            {settled && <span className={`chat-chip-settled chat-chip-settled-${settled}`}>{settledWord(settled)}</span>}
          </span>
        ) : undefined
      }
    />
  )
}

/** Label runs in a row as one tool-call card: Label, the label (or how many) and how long it took, a step per label
 * with what its run counted, the labels' chips, and the runs' state at the right edge, read from their chats' metas. */
function LabelRunsCard({ runs, ws }: { runs: AgentRowT[]; ws: string }) {
  const { metas } = useContext(ThreadsContext)
  const [open, setOpen] = useState(false)
  const items = runs.map((r) => ({ run: r, name: labelRunName(r.title), meta: metas?.get(r.chat) }))
  const states = items.map((it) => it.meta?.status)
  const state: ToolState | null = states.some((st) => st === 'running')
    ? 'running'
    : states.some((st) => st === 'failed' || st === 'stopped')
      ? 'failed'
      : states.length && states.every((st) => st === 'done')
        ? 'done'
        : null
  const first = items[0]?.meta
  const lastEnd = items.every((it) => it.meta?.ts_end) ? items.map((it) => it.meta!.ts_end!).sort().pop() : undefined
  const took = state === 'done' ? durationText(first?.created_at, lastEnd) : ''
  const meta = [items.length === 1 ? items[0].name : `${items.length} labels`, took].filter(Boolean).join(' · ')
  return (
    <ToolCard
      className="chat-tool chat-label-runs"
      data-tool="label-runs"
      data-chats={runs.map((r) => r.chat).join(',')}
      title={<span className="chat-tool-name">Label</span>}
      meta={meta}
      state={state}
      open={open}
      onToggle={setOpen}
      steps={items.map((it) => ({
        key: it.run.chat,
        text: it.meta?.result ? `${it.name} · ${it.meta.result}` : it.name,
        state: it.meta?.status === 'running' ? 'running' : it.meta?.status === 'failed' || it.meta?.status === 'stopped' ? 'failed' : it.meta ? 'done' : 'pending',
      }))}
      chips={
        <ChipRun>
          {items.map((it) => (
            <LabelChip key={`label:${it.name}`} ws={ws} name={it.name} onClick={(e) => (e.stopPropagation(), openLabel(ws, it.name))} />
          ))}
        </ChipRun>
      }
    />
  )
}

/** Views proposed in a row, one note: each proposal's ViewChip, which follows its build. A proposal the orientation
 * dropped is left out, and a note left with none is not drawn. */
function ViewsNote({ chips, ws }: { chips: ChipRowT[]; ws: string }) {
  const proposals = useProposals(ws)
  const shown = chips
    .map((c) => ({ c, p: c.ref ? parseRef(c.ref) : null }))
    .map(({ c, p }) => ({ c, slug: p?.kind === 'view' ? p.slug : null }))
    .filter(({ c, slug }) => !isDropped(proposals, slug, c.text))
  if (!shown.length) return null
  return (
    <Note
      className="chat-views-note"
      data-chip="view"
      text={shown.length === 1 ? 'View proposed' : 'Views proposed'}
      chips={shown.map(({ c, slug }) => (
        <ViewChip key={c.index} ws={ws} slug={slug} name={c.text} />
      ))}
    />
  )
}

/**
 * Whether a pending chip's work has since finished: the stream's `report` events settle it live, and one read of the
 * document settles a chip appended before this page loaded. A view's chip follows its proposal itself (ViewChip).
 */
function useChipSettled(ws: string, item: ChipRowT): Settled | null {
  const [settled, setSettled] = useState<Settled | null>(null)
  const pending = chipPending(item.status)
  const ref = item.ref
  useEffect(() => {
    if (!pending || !ref) return
    let alive = true
    const offReport = bus.on('report', (e) => {
      const s = settleChip(ref, { type: 'report', slug: e.slug, status: e.status })
      if (s && alive) setSettled(s)
    })
    const p = parseRef(ref)
    if (p?.kind === 'report') {
      // the written document, or its frame before a write
      api
        .frame(ws, p.slug)
        .then((d) => {
          if (alive && d.generated_at && !d.partial && !d.frame) setSettled('done')
        })
        .catch(() => undefined)
    }
    return () => {
      alive = false
      offReport()
    }
  }, [ws, ref, pending])
  return settled
}

/** Retry under the error row at `index`: what it runs again, and the line that says nothing else retries it. */
export interface ErrorRetry {
  index: number
  onRetry: () => Promise<unknown>
  note?: string
}

/** Main's line under its API error that Retry can send again (model.apiRetry). */
export const MAIN_RETRY_NOTE = 'Not retried. The turn ended here.'
/** A thread's line under the API error that ended its reply, which Retry asks again. */
export const THREAD_RETRY_NOTE = 'Not retried. The reply ended here.'

/** The line of a view build's card after an API error it waits out (backend dev.run_view). Pure. */
export const buildWaitNote = (wait: number): string => `thimble retries the build after ${waitText(wait)}.`

/** Why a thread's run ended without a reply, each said in its record's message (backend threads.STOP_TEXT). */
const THREAD_STOPS: ReadonlySet<string> = new Set(['session-ended', 'unanswered', 'fork-lost'])

/** An extension's orientation instructions, sent to an orientation that had run when the extension was added: a line
 * naming the extension, the instructions behind the chevron. */
function ExtensionLead({ name, text, ws }: { name: string; text: string; ws: string }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((o) => !o)
  return (
    <div className={`chat-row chat-note chat-extension-lead${open ? ' open' : ''}`}>
      <span
        className="chat-note-head chat-note-act"
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
        <span className="chat-row-word">{leadText({ kind: 'user', index: 0, text, by: 'extension', extension: name })}</span>
        <Icon name="chevron-right" size={10} className="chat-row-caret" />
      </span>
      {open && (
        <div className="chat-row-body">
          <RefText text={text} workspace={ws} />
        </div>
      )}
    </div>
  )
}

/** A reply that stopped or failed, as a quiet line: the ✕ mark and one word (or why a thread's run ended), the detail
 * behind the chevron. An API error is its card instead (ApiErrorCard), with Retry. */
export function ErrorRow({ item, retry }: { item: ErrorRowT; retry?: ErrorRetry }) {
  const [open, setOpen] = useState(false)
  if (item.errorKind === API_ERROR_KIND) {
    const onRetry = retry
      ? () => {
          track('chat-retry', { target: 'chat:main', detail: { error: item.message.split('\n', 1)[0].trim() } })
          return retry.onRetry()
        }
      : undefined
    return (
      <div className="chat-msg chat-api-error" data-error-kind={item.errorKind}>
        <ApiErrorCard line={item.message} retrying={item.wait != null ? buildWaitNote(item.wait) : retry?.note} waits={item.wait != null} onRetry={onRetry} />
      </div>
    )
  }
  const said = item.errorKind && THREAD_STOPS.has(item.errorKind) ? item.message.split('\n', 1)[0].trim() : ''
  const stopped = !!said || item.errorKind === 'interrupted' || item.errorKind === 'stopped'
  const detail = stopped ? (said ? item.detail || '' : '') : item.detail || item.message || ''
  const toggle = () => detail && setOpen((o) => !o)
  const word = said || (stopped ? 'stopped' : 'failed')
  return (
    <div className={`chat-row chat-note chat-error-row${stopped ? ' chat-stopped' : ' chat-failed'}${open ? ' open' : ''}`} role={stopped ? undefined : 'alert'} data-error-kind={item.errorKind}>
      <span
        className={`chat-note-head${detail ? ' chat-note-act' : ''}`}
        role={detail ? 'button' : undefined}
        tabIndex={detail ? 0 : undefined}
        aria-expanded={detail ? open : undefined}
        onClick={toggle}
        onKeyDown={(e) => {
          if (detail && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <Mark kind="failed" label={word} className={`chat-row-mark chat-row-mark-${stopped ? 'stopped' : 'failed'}`} />
        <span className="chat-row-word">{word}</span>
        {detail && <Icon name="chevron-right" size={10} className="chat-row-caret" />}
      </span>
      {open && detail && <div className="chat-row-body chat-error-detail">{detail}</div>}
    </div>
  )
}
