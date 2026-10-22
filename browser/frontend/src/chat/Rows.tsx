// The rows of a chat: the analyst's message as an accent tile, the assistant's markdown as plain text with its marks,
// and the work as tool-call cards. A raw call (Read, Grep, Glob) is one line with its state's glyph, tool and target;
// two or more in a row fold into one chip that names each tool and count (Grep 2 · Read 1). Other runs of one kind of
// call are one card (Label · 2 steps · 31s), and a call of the card tool is its line with the card under it. A notice
// (a failure of thimble's own work, with what to do) is one warning line; an error that ended a turn is a card with
// Retry.
import { useState } from 'react'
import { Chip } from '../components/Chip'
import { CodeText } from '../components/Code'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { UserMessage } from '../components/Message'
import { RefChip, scrubIds } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { ChipRun, ToolCard } from '../components/ToolCard'
import { isDropped, useProposals } from '../lib/proposals'
import { parseRef } from '../lib/refs'
import { Card } from '../cards/Card'
import { startV } from '../cards/keys'
import { useFeature } from '../features'
import { shownMarks, useLenses } from '../lib/lensMarks'
import { MarksFooter } from '../marks/MarksFooter'
import { ChatMarkdown, ChipContext, RefText } from './markdown'
import { callPieces, groupState, groupTools, isRawCall, madeBy, runTools, toolMeta, toolSteps, toolSummary, type BranchRow, type CallsRow, type ErrorRow as ErrorRowT, type Row, type ToolGroup, type ToolRow as ToolRowT, type ViewChipRow } from './model'
import { Note, ThreadChip } from './Notes'
import { midTurnTexts } from './tidy'
import { ErrorCard } from './ErrorCard'
import { NoticeRow } from './Notice'
import { LabelRunRow } from './LabelRun'
import { LabelChip, openLabel } from './SurfaceChips'
import { ViewChip } from './ViewChip'

/** A run of consecutive `view` chips: the views whose builds ended, one note. */
export interface ViewsRow {
  kind: 'views'
  index: number
  chips: ViewChipRow[]
}

/** A call of the card tool: its line, and the card it drew under it (Card.tsx). */
export interface CardCallRow {
  kind: 'cardcall'
  index: number
  tool: ToolRowT
}

export type ShownRow = Exclude<Row, ToolRowT> | ToolGroup | CallsRow | BranchRow | ViewsRow | CardCallRow

/** The rows as the transcript shows them: consecutive raw calls (model.isRawCall) as one run of chip lines, other calls
 * of one kind folded into one card, a card call as a row of its own, consecutive view chips as one note (a view this
 * chat proposed, or one already shown, left out). Pure. */
export function shownRows(rows: readonly (Row | BranchRow)[]): ShownRow[] {
  const out: ShownRow[] = []
  // a view a call of this chat proposed is a chip on that call's card, so its chip note would say it twice
  const proposedHere = new Set(madeBy(rows.filter((r): r is ToolRowT => r.kind === 'tool')).views)
  // a proposal's later chips (built, failed) are the first chip's state, which it reads for itself
  const viewsSeen = new Set<string>()
  for (const r of groupCalls(rows)) {
    if (r.kind === 'tools' && r.tools.every((t) => isRawCall(t.name))) {
      const last = out[out.length - 1]
      if (last && last.kind === 'calls') last.tools.push(...r.tools)
      else out.push({ kind: 'calls', index: r.index, tools: [...r.tools] })
      continue
    }
    if (r.kind === 'chip') {
      const key = r.ref || r.text
      const name = r.text.replace(/: (built|the build failed)$/, '')
      if (proposedHere.has(name) || viewsSeen.has(key)) continue
      viewsSeen.add(key)
      const last = out[out.length - 1]
      if (last && last.kind === 'views') last.chips.push(r)
      else out.push({ kind: 'views', index: r.index, chips: [r] })
      continue
    }
    out.push(r)
  }
  return out
}

/** The rows with each card call as a row of its own, the other calls grouped (model.groupTools). Pure. */
function groupCalls(rows: readonly (Row | BranchRow)[]): (Exclude<Row, ToolRowT> | ToolGroup | BranchRow | CardCallRow)[] {
  const out: (Exclude<Row, ToolRowT> | ToolGroup | BranchRow | CardCallRow)[] = []
  let run: (Row | BranchRow)[] = []
  const flush = () => {
    out.push(...groupTools(run))
    run = []
  }
  for (const r of rows) {
    if (r.kind === 'tool' && r.name === 'card') {
      flush()
      out.push({ kind: 'cardcall', index: r.index, tool: r })
    } else run.push(r)
  }
  flush()
  return out
}

/** Where each card draws, and its newest version. A card has one place, as in the terminal: under the answer v was
 * pressed on when v drew it, else under the first call that drew it; each new version replaces it there, and every
 * other call of it points to that place. */
type CardPlace = { at: number | 'v'; version: number }
function cardPlaces(rows: readonly ShownRow[]): Map<string, CardPlace> {
  const out = new Map<string, CardPlace>()
  for (const r of rows) if (r.kind === 'text') for (const id of r.cards ?? []) out.set(id, { at: 'v', version: 0 })
  for (const r of rows) {
    const got = r.kind === 'cardcall' ? r.tool.result : undefined
    if (!got?.card) continue
    const was = out.get(got.card)
    out.set(got.card, { at: was?.at ?? r.index, version: Math.max(was?.version ?? 0, got.version ?? 0) })
  }
  return out
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * The rows of one chat. `streaming` marks the last text row as still growing. `chat` is the log's chat id: every
 * message body carries `data-anchor="chat:<id>#<index>"`, so a ⌘-click starts a thread there. `live` marks the calls of
 * a run still going. `retry` names the error row whose Retry sends the analyst's message again.
 */
export function Rows({ rows, ws, chat, streaming = false, live = false, retry }: { rows: readonly (Row | BranchRow)[]; ws: string; chat?: string; streaming?: boolean; live?: boolean; retry?: ErrorRetry }) {
  const lastText = streaming ? [...rows].reverse().find((r): r is Extract<Row, { kind: 'text' }> => r.kind === 'text') : undefined
  const anchorOf = (index: number) => (chat ? `chat:${chat}#${index}` : undefined)
  const shown = shownRows(rows)
  // a text before a later call of its turn is a step's note, drawn with the steps; the reply is the text after them,
  // or the last text before the last call when nothing follows it
  const notes = midTurnTexts(shown, streaming || live)
  // the lenses whose marks show in the chat (lib/lensMarks.ts): a lens turned off for the chat hides its marks at once
  const lenses = useLenses(ws)
  const places = cardPlaces(shown)
  const cardsOn = useFeature('cards')
  // v draws a card of the chat's last reply, once it is whole
  const lastTurn = shown.reduce((at, r, i) => (r.kind === 'user' ? i : at), -1)
  const reply = streaming || live ? -1 : shown.reduce((at, r, i) => (i > lastTurn && r.kind === 'text' && !notes.has(r.index) && r.text.trim() ? i : at), -1)
  return (
    <ChipContext.Provider value={{ workspace: ws, broken: EMPTY, anchor: true }}>
      {shown.map((r, i) => {
        switch (r.kind) {
          case 'user':
            return (
              <div key={r.index} className="chat-msg chat-user">
                <UserMessage className="chat-message" data-anchor={anchorOf(r.index)} data-anchor-text={chat ? r.text : undefined}>
                  <RefText text={r.text} workspace={ws} />
                </UserMessage>
              </div>
            )
          case 'text':
            return (
              <div key={r.index} className={`chat-msg chat-assistant${notes.has(r.index) ? ' chat-step-note' : ''}`}>
                <div className="chat-text" data-anchor={anchorOf(r.index)} data-anchor-text={chat ? r.text : undefined}>
                  <ChatMarkdown text={r.text} streaming={r === lastText} checks={r.checks} marks={shownMarks(r.lensMarks, lenses, 'chat')} lenses={lenses} />
                </div>
                {r.turnMarks && <MarksFooter items={r.turnMarks} />}
                {(r.cards ?? []).map((id) => (
                  <Card key={id} ws={ws} id={id} />
                ))}
                {i === reply && cardsOn && chat && (
                  <button type="button" className="chat-v" title="A copy of this chat draws a card of this answer" onClick={() => startV(ws, chat)}>
                    <kbd>v</kbd> draw a card of this answer
                  </button>
                )}
              </div>
            )
          case 'cardcall':
            return <CardCall key={r.index} tool={r.tool} ws={ws} running={streaming && i === shown.length - 1 && !r.tool.result} place={places.get(r.tool.result?.card ?? '')} />
          case 'tools':
            return <ToolGroupCard key={r.index} group={r} ws={ws} pending={streaming && i === shown.length - 1} />
          case 'calls':
            return <CallLines key={r.index} tools={r.tools} ws={ws} pending={live || (streaming && i === shown.length - 1)} />
          case 'views':
            return <ViewsNote key={r.index} chips={r.chips} ws={ws} />
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
          case 'error':
            return <ErrorRow key={r.index} item={r} retry={retry && retry.index === r.index ? retry : undefined} />
          case 'notice':
            return <NoticeRow key={r.index} item={r} />
          case 'label_run':
            return <LabelRunRow key={r.index} item={r} ws={ws} />
        }
      })}
      {/* while the reply runs, the busy line above the input box says `answering` with its seconds (ChatBusy) */}
    </ChipContext.Provider>
  )
}

// the input fields that hold code, each with the language it is colored in (components/Code.tsx)
const CODE_KEYS = new Map([
  ['code', 'python'],
  ['view', 'javascript'],
  ['text', 'markdown'],
])

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

/**
 * The rows an open tool row shows for its input: strings as text or code, anything else as JSON. A string field the
 * head's `summary` already shows whole (the pattern of a search, the path of a read) is left out.
 */
function inputRows(input: unknown, summary = ''): InputRow[] {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return input == null ? [] : [{ key: '', kind: 'json', value: scrubIds(safeJson(input)) }]
  const out: InputRow[] = []
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (v == null || v === '') continue
    let row: InputRow
    if (typeof v === 'string') row = { key, kind: CODE_KEYS.has(key) ? 'code' : 'text', value: v }
    else if (typeof v === 'number' || typeof v === 'boolean') row = { key, kind: 'text', value: String(v) }
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) row = { key, kind: 'text', value: v.map(String).join(', ') }
    else row = { key, kind: 'json', value: scrubIds(safeJson(v)) }
    const one = row.value.replace(/\s+/g, ' ').trim()
    if (row.kind === 'text' && one && summary.includes(one)) continue
    out.push(row)
  }
  return out
}

/** What an open call shows: its input fields the head does not already print, and its result as text unless it left a
 * label's card (the label's chip is the result) or it failed (the error is). Pure. */
function callParts(tool: ToolRowT, summary: string): { rows: InputRow[]; result: string; failed: boolean } {
  const failed = !!tool.result?.is_error
  const result = tool.result && (!tool.result.label_card || failed) ? scrubIds(tool.result.summary) : ''
  return { rows: inputRows(tool.input, summary), result, failed }
}

/** The body an open single call shows (callParts); nothing when it has nothing more to say. A failed call shows its
 * error before its input. */
function CallBody({ tool, ws, summary }: { tool: ToolRowT; ws: string; summary: string }) {
  const { rows, result, failed } = callParts(tool, summary)
  if (!rows.length && !result) return null
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
  const output = result && (
    <>
      {failed && <div className="chat-tool-label label">Error</div>}
      <div className={`chat-tool-result${failed ? ' chat-tool-result-error' : ''}`}>
        <RefText text={result} workspace={ws} />
      </div>
    </>
  )
  return (
    <>
      {failed ? output : fields}
      {failed ? fields : output}
    </>
  )
}

/** The chips of what calls made: the views proposed and the labels applied. */
function madeChips(tools: readonly ToolRowT[], ws: string) {
  const made = madeBy(tools)
  return [
    ...made.views.map((v) => <ViewChip key={`view:${v}`} ws={ws} slug={made.viewSlugs[v]} name={v} />),
    ...made.labels.map((l) => <LabelChip key={`label:${l}`} name={l} onClick={(e) => (e.stopPropagation(), openLabel(ws, l))} />),
  ]
}

/** A run of calls of one kind as one tool-call card. One call's card names what it was about in the meta and opens to
 * its input and result as well as its step; what the calls made are chips under the head. */
function ToolGroupCard({ group, ws, pending }: { group: ToolGroup; ws: string; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = group.tools
  const single = tools.length === 1 ? tools[0] : null
  const summary = single ? toolSummary(single.name, single.input, ws) : ''
  const chips = madeChips(tools, ws)
  return (
    <ToolCard
      className="chat-tool"
      data-tool={single ? single.name : group.name}
      title={<span className="chat-tool-name">{group.name}</span>}
      meta={single && !chips.length && summary ? summary : toolMeta(tools)}
      state={groupState(tools, pending)}
      open={open}
      onToggle={setOpen}
      steps={toolSteps(tools, pending)}
      body={open && single ? <CallBody tool={single} ws={ws} summary={summary} /> : null}
      chips={chips.length > 0 ? <ChipRun>{chips}</ChipRun> : undefined}
    />
  )
}

/** A run of calls: two or more raw calls in a row as one folded chip (CallRun), every other call a line of its own. */
function CallLines({ tools, ws, pending }: { tools: readonly ToolRowT[]; ws: string; pending: boolean }) {
  return (
    <div className="chat-msg chat-calls">
      {callPieces(tools).map((p) =>
        p.kind === 'run' ? (
          <CallRun key={p.tools[0].id} tools={p.tools} ws={ws} pending={pending} />
        ) : (
          <CallLine key={p.tool.id} tool={p.tool} ws={ws} running={pending && !p.tool.result} />
        ),
      )}
    </div>
  )
}

/**
 * Calls in a row as one call chip naming each tool and count (model.runTools), a spinner while one runs, and the
 * failed count, which opens those calls alone. A click opens every line (CallLine).
 */
function CallRun({ tools, ws, pending }: { tools: readonly ToolRowT[]; ws: string; pending: boolean }) {
  const [open, setOpen] = useState<'all' | 'failed' | null>(null)
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
            <CallLine key={`${open}:${t.id}`} tool={t} ws={ws} running={pending && !t.result} startOpen={open === 'failed'} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One call as Claude Code prints its line: its state's glyph, the tool and its target in mono, and the chips of what
 * it made. A click opens the call's other input fields and its result.
 */
function CallLine({ tool, ws, running, startOpen = false }: { tool: ToolRowT; ws: string; running: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const summary = toolSummary(tool.name, tool.input, ws)
  const { rows, result, failed } = callParts(tool, summary)
  const opens = rows.length > 0 || !!result
  const state = running ? 'running' : failed ? 'failed' : tool.result ? 'done' : undefined
  const words = (
    <>
      <span className="chat-call-tool">{tool.name}</span>
      {summary && (
        <>
          {' '}
          <span className="chat-call-target">{summary}</span>
        </>
      )}
    </>
  )
  return (
    <div className={`chat-call${open && opens ? ' open' : ''}`} data-tool={tool.name} data-state={state}>
      <span className="chat-call-head">
        <span className="chat-call-state" aria-hidden={running || failed ? undefined : true}>
          {running ? <Spinner size={10} label="running" /> : failed ? <Mark kind="failed" label="failed" className="chat-call-mark" /> : <span className="chat-call-dot" />}
        </span>
        {opens ? (
          <button type="button" className="chat-call-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {words}
          </button>
        ) : (
          <span className="chat-call-chip">{words}</span>
        )}
        {madeChips([tool], ws)}
      </span>
      {open && opens && (
        <div className="chat-call-body">
          <CallBody tool={tool} ws={ws} summary={summary} />
        </div>
      )}
    </div>
  )
}

/** A call of the card tool: its line, then the card when the card's place is this call, else a line that points to its
 * place (cardPlaces). */
function CardCall({ tool, ws, running, place }: { tool: ToolRowT; ws: string; running: boolean; place?: CardPlace }) {
  const card = tool.result?.card
  const version = tool.result?.version ?? 0
  const here = place?.at === tool.index
  const now = place && version < place.version ? `, now version ${place.version}` : ''
  return (
    <div className="chat-msg chat-cardcall">
      <CallLine tool={tool} ws={ws} running={running} />
      {card && here && <Card ws={ws} id={card} version={place.version} />}
      {card && place && !here && (
        <div className="chat-card-moved">
          ↑ version {version} · “{tool.result?.title ?? 'the card'}” is drawn in its place {place.at === 'v' ? 'under the answer v was pressed on' : 'above'}
          {now}
        </div>
      )}
    </div>
  )
}

/** Views whose builds ended, one note: each proposal's ViewChip, which follows its build. A dropped proposal is left
 * out, and a note left with none is not drawn. */
function ViewsNote({ chips, ws }: { chips: ViewChipRow[]; ws: string }) {
  const proposals = useProposals(ws)
  const shown = chips
    .map((c) => ({ c, p: c.ref ? parseRef(c.ref) : null }))
    .map(({ c, p }) => ({ c, slug: p?.kind === 'view' ? p.slug : null, name: c.text.replace(/: (built|the build failed)$/, '') }))
    .filter(({ slug, name }) => !isDropped(proposals, slug, name))
  if (!shown.length) return null
  return (
    <Note
      className="chat-views-note"
      data-chip="view"
      text={shown.length === 1 ? 'View' : 'Views'}
      chips={shown.map(({ c, slug, name }) => (
        <ViewChip key={c.index} ws={ws} slug={slug} name={name} />
      ))}
    />
  )
}

/** Retry under the error row at `index`: what it runs again. */
export interface ErrorRetry {
  index: number
  onRetry: () => Promise<unknown>
}

/** An error that ended a turn: its card with what failed and what to do (backend llm.failure), and Retry when it is the
 * chat's last row and the request may go through again. */
function ErrorRow({ item, retry }: { item: ErrorRowT; retry?: ErrorRetry }) {
  return (
    <div className="chat-msg chat-api-error" data-error-kind={item.errorKind}>
      <ErrorCard text={item.message} onRetry={retry?.onRetry} />
    </div>
  )
}
