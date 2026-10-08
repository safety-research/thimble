// The Checks pane, shared by every document type: one row per report check (GET /ws/{c}/checks, built-ins first), each
// with its colour square to show or hide its tints and comments, its count of open comments (or a spinner while it
// runs, ✕ when it failed), and ⋯ to open its card (CheckCard). + opens the new-check card. Whether a check is on is
// kept on the server (`shown`), and the server runs what the pane asks for (backend checks.py); `check` stream records
// say when a run starts and ends. `useChecks` holds the list; `useSidebar` is the sidebar's state (shown or hidden,
// beside the document or over it).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Button } from '../components/Button'
import { TextArea, TextInput } from '../components/Field'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { openThread } from '../chat/Notes'
import { colourVar } from '../files/labels'
import { checksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Check, CheckRun } from '../lib/types'
import { refusalLine } from '../chat/Refused'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { useDock, useFoldingSide, type FoldingSide } from '../shell/dock'
import { sideKey } from './cards'
import { checkColour, checkLook, countsByCheck, freeColour, nameTaken, rowCount, runLine, runOf, shownIds, withCheck, withRun, withShown, type CheckLook, type DocComment } from './checkComments'
import { Chevron, Glyph, IconButton } from './icons'

const REFETCH_DEBOUNCE_MS = 150

export interface Checks {
  /** every check, the built-ins first, as the server lists them */
  list: readonly Check[]
  /** the ids of the checks that are on */
  on: ReadonlySet<string>
  /** how the page draws a check's comments: colour, name, place in the pane */
  look: CheckLook
  /** a check turned on or off (`next` given), or flipped */
  toggle: (id: string, next?: boolean) => void
  /** a new check from the pane, which the server turns on; false when the server refused it */
  create: (name: string, prompt: string) => Promise<boolean>
  /** a check's new prompt; false when the server refused it */
  editPrompt: (id: string, prompt: string) => Promise<boolean>
}

const toast = (what: string, e: unknown) => bus.emit('toast', { text: `${what} ${(e as Error).message}`, kind: 'error' })

/** The workspace's checks, read again when the stream says a run started or ended. */
export function useChecks(ws: string): Checks {
  const [list, setList] = useState<Check[]>([])
  const current = useRef<Check[]>(list)
  const put = useCallback((next: Check[]) => {
    current.current = next
    setList(next)
  }, [])

  useEffect(() => {
    let live = true
    let timer: number | null = null
    const read = () =>
      checksApi
        .list(ws)
        .then((l) => live && put(l))
        .catch(() => {
          /* the pane stands empty; the page still shows the analyst's own comments */
        })
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), REFETCH_DEBOUNCE_MS)
    }
    put([])
    void read()
    const offs = [
      // the run's state at once, then the list for what the run changed (its count, its line, a check main made)
      bus.on('check', (e) => {
        put(withRun(current.current, e.id, e.doc, { status: e.status, run: e.run, chat: e.chat }))
        later()
      }),
      bus.on('wsStream', (e) => e.connected && later()),
    ]
    return () => {
      live = false
      if (timer != null) window.clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [ws, put])

  const toggle = useCallback(
    (id: string, next?: boolean) => {
      const cur = current.current.find((c) => c.id === id)
      if (!cur) return
      const shown = next ?? !cur.shown
      if (shown === cur.shown) return
      put(withShown(current.current, id, shown))
      track('ui-click', { target: 'ui:report-check', detail: { check: id, on: shown } })
      checksApi
        .update(ws, id, { shown })
        .then((saved) => put(withCheck(current.current, saved)))
        .catch((e) => {
          put(withShown(current.current, id, !shown))
          toast(`Could not turn the check ${shown ? 'on' : 'off'}.`, e)
        })
    },
    [ws, put],
  )

  const create = useCallback(
    async (name: string, prompt: string) => {
      try {
        const made = await checksApi.create(ws, { name: name.trim(), prompt: prompt.trim() })
        put(withCheck(current.current, made))
        track('ui-click', { target: 'ui:report-check-new', detail: { check: made.id } })
        return true
      } catch (e) {
        toast('Could not add the check.', e)
        return false
      }
    },
    [ws, put],
  )

  const editPrompt = useCallback(
    async (id: string, prompt: string) => {
      try {
        const saved = await checksApi.update(ws, id, { prompt })
        put(withCheck(current.current, saved))
        track('ui-click', { target: 'ui:report-check-prompt', detail: { check: id, chars: prompt.length } })
        return true
      } catch (e) {
        toast('Could not save the prompt.', e)
        return false
      }
    },
    [ws, put],
  )

  const on = useMemo(() => shownIds(list), [list])
  const look = useMemo(() => checkLook(list), [list])
  return { list, on, look, toggle, create, editPrompt }
}

/** The passages that changed since a run checked them (the analyst's own edits), while it does not run. Pure. */
export function staleOf(run: Pick<CheckRun, 'stale' | 'status'> | null | undefined): number {
  return run && run.status !== 'running' && typeof run.stale === 'number' && run.stale > 0 ? run.stale : 0
}

/** A stale row's words: how many passages changed since the check last ran on them. Pure. */
export const staleText = (n: number): string => `${n} passage${n === 1 ? '' : 's'} changed since checked`

/** The tip of a running check's spinner: open its run, or what it waits for, since it has no chat yet. Pure. */
export function checkRunLabel(name: string, run: { chat?: string | null; waiting?: string | null }): string {
  if (run.chat) return `${name} is running: open its run`
  if (run.waiting === 'writer') return `${name} runs once the writer has finished`
  if (run.waiting === 'plan') return `${name} runs once your session leaves plan mode (shift+tab in your terminal)`
  return `${name} waits for a free session`
}

/** A check whose passages the analyst changed since it ran: nothing runs by itself (a writer's save runs the checks, the
 * analyst's own edits do not), so the row says how many changed, and Run is a click that starts the check's agent
 * through thimble's plugin on them (POST /checks/{id}/run). */
function StaleRow({ ws, check, doc, n }: { ws: string; check: Check; doc: string; n: number }) {
  const [busy, setBusy] = useState(false)
  return (
    <p className="wu-check-stale" data-stale={n}>
      {`${staleText(n)} · `}
      <Button
        variant="ghost"
        size="sm"
        className="wu-check-stale-run"
        busy={busy}
        onClick={() => {
          setBusy(true)
          track('ui-click', { target: 'ui:report-check-run', detail: { check: check.id, doc, stale: n } })
          checksApi
            .run(ws, check.id, doc)
            .then((r) => {
              if (r?.refused) bus.emit('toast', { text: `${check.name} didn't start: ${refusalLine(r.refused)}`, kind: 'error' })
            })
            .catch((e) => toast(`Could not run ${check.name}.`, e))
            .finally(() => setBusy(false))
        }}
      >
        Run
      </Button>
    </p>
  )
}

/** The width of a document's sidebar, as .wu-side sets it in report.css. */
const SIDE_WIDTH = 260

export interface DocSidebar extends FoldingSide {
  /** the refs of the row that holds the sidebar and the document, and of the ReadProbe in it */
  row: (el: HTMLElement | null) => void
  probe: (el: HTMLElement | null) => void
}

/** A document's sidebar, the same for every type. While the pane holds it beside a column of 60-character lines of
 * the report's text (the row's ReadProbe, report.css), it docks and shows as the analyst left it, per workspace;
 * hidden, a toggle over the page's top left brings it back. In a narrower pane it starts folded to that toggle, which
 * opens it over the document's left edge (shell/dock.tsx useFoldingSide). */
export function useSidebar(ws: string): DocSidebar {
  const [side, setSide] = useState<boolean>(() => readStorage<boolean>(sideKey(ws), true) !== false)
  const { docks, row, probe } = useDock(SIDE_WIDTH)
  const keep = useCallback(
    (next: boolean) => {
      setSide(next)
      writeStorage(sideKey(ws), next)
    },
    [ws],
  )
  const fold = useFoldingSide(docks, side, keep)
  const note = (open: boolean) => track('ui-click', { target: 'ui:report-sidebar', detail: { open, over: !docks } })
  const show = () => {
    fold.show()
    note(true)
  }
  const hide = () => {
    fold.hide()
    note(false)
  }
  return { ...fold, show, hide, row, probe }
}

export interface ChecksPaneProps {
  ws: string
  /** the document shown, whose runs the rows show */
  doc: string
  checks: Checks
  /** the document's open comments, whether their check is on or off */
  comments: readonly DocComment[]
  /** the sidebar's hide toggle, in the pane's head when the pane is the whole sidebar */
  onHide?: () => void
}

export function ChecksPane({ ws, doc, checks, comments, onHide }: ChecksPaneProps) {
  const key = storageKey(ws, 'report-checks-pane')
  const [open, setOpen] = useState<boolean>(() => readStorage<boolean>(key, true) !== false)
  // the check whose card is open, or 'new' for the new-check card, with the element the card stands beside
  const [editing, setEditing] = useState<{ id: string; at: HTMLElement } | null>(null)
  const head = useRef<HTMLDivElement | null>(null)
  const counts = useMemo(() => countsByCheck(comments), [comments])
  const shownCount = comments.filter((c) => c.check != null && checks.on.has(c.check)).length
  const anyResult = checks.list.some((c) => rowCount(runOf(c, doc), counts.get(c.id) ?? 0) != null)
  const setPane = (next: boolean) => {
    setOpen(next)
    writeStorage(key, next)
  }
  const edit = (id: string, at: HTMLElement | null) => setEditing((e) => (e?.id === id || !at ? null : { id, at }))
  const close = useCallback(() => setEditing(null), [])
  const editCheck = editing && editing.id !== 'new' ? (checks.list.find((c) => c.id === editing.id) ?? null) : null
  return (
    <div className="wu-checks" aria-label="Checks">
      <div className="wu-checks-head" ref={head}>
        <button type="button" className="wu-sec-head" aria-expanded={open} onClick={() => setPane(!open)}>
          <Chevron open={open} />
          <span className="wu-sec-name">Checks</span>
          {anyResult && <span className="wu-count wu-count-inline">{shownCount}</span>}
        </button>
        <IconButton label="New check" className="wu-checks-add" aria-expanded={editing?.id === 'new'} onClick={() => edit('new', head.current)}>
          <Icon name="plus" size={14} />
        </IconButton>
        {onHide && (
          <IconButton label="Hide sidebar" onClick={onHide}>
            <Glyph name="sidebar" />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="wu-checks-list">
          {checks.list.map((c) => {
            const isOn = checks.on.has(c.id)
            const isOpen = editing?.id === c.id
            const colour = checkColour(c)
            const run = runOf(c, doc)
            const count = rowCount(run, counts.get(c.id) ?? 0)
            const notRun = count == null && run?.status !== 'running' && run?.status !== 'failed'
            const rowOf = (el: HTMLElement) => el.closest<HTMLElement>('.wu-check-row')
            return (
              <div key={c.id} className="wu-check" data-check={c.id}>
                <div className={`wu-check-row${isOn ? ' on' : ''}${isOpen ? ' editing' : ''}`}>
                  <button type="button" className="wu-check-toggle" role="switch" aria-checked={isOn} onClick={() => checks.toggle(c.id)}>
                    <span className="wu-check-sq" style={{ borderColor: colour, background: isOn ? colour : 'transparent' }} />
                    <span className="wu-check-name">{c.name}</span>
                    {count != null && <span className="wu-count">{count}</span>}
                    {notRun && <span className="wu-count wu-count-none">–</span>}
                  </button>
                  {run?.status === 'running' && (
                    // a run waiting for a free session, queued until the document's writer ends, or held while main is
                    // in plan mode has no chat yet: the tip says which, and a click does nothing
                    <IconButton
                      label={checkRunLabel(c.name, run)}
                      className="wu-check-run"
                      aria-disabled={!run.chat || undefined}
                      onClick={() => run.chat && openThread(run.chat, 'report-check')}
                    >
                      <Spinner size={10} />
                    </IconButton>
                  )}
                  {run?.status === 'failed' && (
                    // a run that failed before its session started has no chat: its tip says why, and its card runs it
                    // again
                    <IconButton
                      label={`${c.name} failed${run.summary ? `: ${run.summary}` : ''}${run.chat ? '. Open its run' : ''}`}
                      className="wu-check-run"
                      onClick={(e) => (run.chat ? openThread(run.chat, 'report-check') : edit(c.id, rowOf(e.currentTarget)))}
                    >
                      <Mark kind="failed" />
                    </IconButton>
                  )}
                  <IconButton label={`Edit ${c.name}`} className="wu-check-more" aria-expanded={isOpen} onClick={(e) => edit(c.id, rowOf(e.currentTarget))}>
                    <Icon name="more-horizontal" size={14} />
                  </IconButton>
                </div>
                {staleOf(run) > 0 && <StaleRow ws={ws} check={c} doc={doc} n={staleOf(run)} />}
                {run?.refused && run.status !== 'running' && <p className="wu-check-refused" role="status">{`Didn't start: ${refusalLine(run.refused)}`}</p>}
              </div>
            )
          })}
        </div>
      )}
      <Popover anchor={editing?.at ?? null} open={editing?.id === 'new' || !!editCheck} onClose={close} side="aside" width={340} label={editCheck ? `Edit ${editCheck.name}` : 'New check'} className="check-card">
        {editing?.id === 'new' ? (
          <NewCheckCard
            colour={colourVar(freeColour(checks.list))}
            taken={(name) => nameTaken(checks.list, name)}
            onClose={close}
            onAdd={async (name, prompt) => {
              if (await checks.create(name, prompt)) close()
            }}
          />
        ) : editCheck ? (
          <CheckCard
            key={editCheck.id}
            ws={ws}
            doc={doc}
            check={editCheck}
            on={checks.on.has(editCheck.id)}
            comments={counts.get(editCheck.id) ?? 0}
            onSave={(prompt) => checks.editPrompt(editCheck.id, prompt)}
            onClose={close}
          />
        ) : null}
      </Popover>
    </div>
  )
}

/** ⌘↵ or Ctrl+↵ in a field: save. */
const isSave = (e: KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey)

/** A card's keys: Escape closes it, and no key reaches the report's own handlers, which the card's portal still bubbles
 * to through React. */
const keepKeys = (onClose: () => void) => (e: KeyboardEvent) => {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    onClose()
  }
}

/** A check's card beside its row: its colour and name, its run on the document shown (with Stop while it runs), its
 * prompt edited in place, and its comment count. Re-run saves a new prompt and runs it (checks.edit_route) or runs it
 * as it is (checks.run_route); Save, for a check that is off, saves the prompt alone. A prompt stored meanwhile
 * replaces a field nobody is editing. */
function CheckCard({ ws, doc, check, on, comments, onSave, onClose }: {
  ws: string
  doc: string
  check: Check
  on: boolean
  /** how many open comments the check has on the document */
  comments: number
  onSave: (prompt: string) => Promise<boolean>
  onClose: () => void
}) {
  const [text, setText] = useState(check.prompt)
  const [busy, setBusy] = useState(false)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(check.prompt)
  }, [check.prompt])
  const run = runOf(check, doc)
  const running = run?.status === 'running'
  const line = runLine(run)
  const dirty = text.trim() !== check.prompt.trim()
  const ready = !!text.trim() && !busy && (dirty || (on && !running))
  const submit = async () => {
    if (!ready) return
    setBusy(true)
    let ok = false
    if (dirty) ok = await onSave(text.trim())
    else {
      track('ui-click', { target: 'ui:report-check-run', detail: { check: check.id, action: 'run' } })
      ok = await checksApi.run(ws, check.id, doc).then(
        () => true,
        (e) => (toast('Could not run the check.', e), false),
      )
    }
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <div className="check-card-body" onKeyDown={keepKeys(onClose)}>
      <div className="label-card-head">
        <span className="label-card-swatch" style={{ '--c': checkColour(check) } as CSSProperties} />
        <span className="label-sheet-name">{check.name}</span>
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </div>
      {line && (
        <div className="label-card-grid">
          <span className="label-card-key">Last run</span>
          <RunLine ws={ws} check={check} doc={doc} line={line} running={running} />
        </div>
      )}
      <div className="label-card-body">
        <TextArea
          block
          autoGrow
          rows={2}
          maxHeight={180}
          value={text}
          onChange={(v) => {
            editing.current = true
            setText(v)
          }}
          onKeyDown={(e) => {
            if (isSave(e)) {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={busy}
          aria-label={`${check.name} prompt`}
          className="label-card-text"
        />
      </div>
      {comments > 0 && (
        <div className="label-card-classes">
          <div className="label-card-classes-head">
            <span className="label-card-key">Comments</span>
            <span className="label-card-hl">{comments}</span>
          </div>
        </div>
      )}
      <div className="label-card-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>
          {on ? 'Re-run' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

/** The check's run on the document shown, in its card: what it does or how it ended and why (runLine), with Stop while
 * it runs or waits (backend checks.stop_route); the stream's `check` record brings the new state to the card. */
function RunLine({ ws, check, doc, line, running }: { ws: string; check: Check; doc: string; line: string; running: boolean }) {
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    setBusy(true)
    track('ui-click', { target: 'ui:report-check-run', detail: { check: check.id, action: 'stop' } })
    try {
      await checksApi.stop(ws, check.id, doc)
    } catch (e) {
      toast('Could not stop the run.', e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="wu-check-runline" data-status={runOf(check, doc)?.status}>
      <span className="wu-check-runline-text">{line}</span>
      {running && (
        <Button size="sm" variant="ghost" icon="stop" busy={busy} onClick={() => void stop()}>
          Stop
        </Button>
      )}
    </span>
  )
}

/** The head's + opens this card beside the pane, laid out as a label's edit card in Files: the colour the server will
 * give the check and its name, its prompt, then Cancel and Run. Enter in the name goes to the prompt; ⌘↵ in the prompt
 * or Run adds the check, which the server turns on and runs. Run waits for a name no other check has and a prompt. */
function NewCheckCard({ colour, taken, onAdd, onClose }: { colour: string; taken: (name: string) => boolean; onAdd: (name: string, prompt: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const nameEl = useRef<HTMLInputElement | null>(null)
  const promptEl = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    // the popover shows the card once it has placed it, and a hidden field takes no focus
    const id = requestAnimationFrame(() => nameEl.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])
  const ready = !!name.trim() && !!prompt.trim() && !taken(name)
  const add = async () => {
    if (!ready || busy) return
    setBusy(true)
    await onAdd(name, prompt)
    setBusy(false)
  }
  return (
    <div className="check-card-body" onKeyDown={keepKeys(onClose)}>
      <div className="label-card-head">
        <span className="label-card-swatch" style={{ '--c': colour } as CSSProperties} />
        <TextInput
          ref={nameEl}
          bare
          value={name}
          onChange={setName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              promptEl.current?.focus()
            }
          }}
          disabled={busy}
          aria-label="Name"
          aria-invalid={taken(name) || undefined}
          className="label-card-name"
          spellCheck={false}
        />
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </div>
      <div className="label-card-body">
        <TextArea
          ref={promptEl}
          block
          autoGrow
          rows={2}
          maxHeight={180}
          value={prompt}
          onChange={setPrompt}
          onKeyDown={(e) => {
            if (isSave(e)) {
              e.preventDefault()
              void add()
            }
          }}
          disabled={busy}
          aria-label="Prompt"
          className="label-card-text"
        />
      </div>
      <div className="label-card-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void add()}>
          Run
        </Button>
      </div>
    </div>
  )
}

/** The sidebar of the slides, the story and a page: the Checks pane alone, with the hide toggle in its head; `over`
 * when it shows over the view's left edge. */
export function ChecksSidebar({ onHide, over, ...pane }: ChecksPaneProps & { onHide: () => void; over: boolean }) {
  return (
    <aside className={'wu-side wu-side-checks' + (over ? ' is-over' : '')} aria-label="Checks">
      <ChecksPane {...pane} onHide={onHide} />
    </aside>
  )
}

/** The toggle that brings a hidden sidebar back, over the page's top left. */
export function SidebarShow({ onShow }: { onShow: () => void }) {
  return (
    <IconButton label="Show sidebar" className="wu-side-show" onClick={onShow}>
      <Glyph name="sidebar" />
    </IconButton>
  )
}
