// thimble fix in the chat (backend fixes.py, chat/fix.ts), in three places:
//   FixWorking  the row above the composer while Claude fixes the person's thimble and the kernel checks the fix: what it
//               fixes and for how long so far. The person keeps working.
//   FixNotice   one notice at the top of the chat once the fix ended. A fix that passed its checks asks: "✓ thimble
//               fixed: <title> · tests pass" with Use it now, What changed (a few lines, not a diff) and Later. Nothing
//               goes on by itself: Use it now is the person's click. The server then starts again from the fixed code,
//               the notice says "Reloading thimble…", and the page loads the new build by itself when nothing typed
//               would be lost; after it, "✓ <title> is on" with Undo. A fix that did not pass says why, with Redo.
//   Your fixes  `/thimble-fix` alone: every fix with its state, Use it on a ready one (Later leaves it there), Undo on
//               one that is on.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { servedBuild, thisBuild } from '../lib/chunkRecovery'
import { track } from '../lib/telemetry'
import { changedLines, fixActions, fixText, reloading, STATE_WORDS, working, workingText, type FixAction, type FixRow } from './fix'

const ICON = { ready: 'check', fixed: 'check', undone: 'undo', request: 'flag', failed: 'warning', problem: 'warning' } as const
const LABEL: Record<FixAction, string> = { use: 'Use it now', what: 'What changed', later: 'Later', undo: 'Undo', redo: 'Redo' }
const FIXED = 'thimble fixed:'

/** Whether the page holds typed text a reload would lose. */
function typing(): boolean {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type=text]')).some((el) => el.value.trim() !== '')
}

/** The fixes the page shows now, read again on each `fix` event and when the stream comes back (`onBack`, else a
 * read). */
function useFixes(onBack?: () => void): [FixRow[], () => void] {
  const [rows, setRows] = useState<FixRow[]>([])
  const load = useCallback(() => {
    api
      .fixes()
      .then((s) => setRows(s.fixes))
      .catch(() => undefined)
  }, [])
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    load()
    const offFix = bus.on('fix', load)
    const offStream = bus.on('wsStream', (e) => {
      if (!e.connected) return
      if (back.current) back.current()
      else load()
    })
    return () => {
      offFix()
      offStream()
    }
  }, [load])
  return [rows, load]
}

function failText(what: string, e: Error): string {
  return `${what} didn't work: ${e.message.replace(/^\d{3}\s+/, '')}`
}

/** The row above the composer while Claude fixes the person's thimble. */
export function FixWorking() {
  const [rows] = useFixes()
  const row = rows.find(working) ?? null
  const [, tick] = useState(0)
  const on = row !== null
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [on])
  if (!row) return null
  return (
    <div className="chat-fix" role="status" data-fix={row.id} data-kind="working" data-phase={row.phase ?? undefined}>
      <Spinner size={12} className="chat-fix-ico" />
      <span className="chat-fix-text">{workingText(row)}</span>
    </div>
  )
}

/** The notice at the top of the chat for the newest fix that ended, and Your fixes. */
export function FixNotice({ ws }: { ws: string }) {
  const restarting = useRef(false)
  const [held, setHeld] = useState<'reload' | 'typed' | null>(null)
  const [rows, load] = useFixes(() => {
    if (!restarting.current) return load()
    // the server came back from the restart the person's click asked for: the page loads its new build
    restarting.current = false
    void Promise.all([thisBuild(), servedBuild()]).then(([a, b]) => {
      if (a && b && a !== b) {
        if (!typing()) {
          setHeld('reload')
          window.location.reload()
          return
        }
        setHeld('typed')
      }
      load()
    })
  })
  const row = rows.find((r) => !working(r)) ?? null
  if (row && reloading(row)) restarting.current = true
  const [busy, setBusy] = useState<FixAction | 'dismiss' | null>(null)
  const [what, setWhat] = useState<number | null>(null)
  const [list, setList] = useState(false)
  useEffect(() => bus.on('fixList', (e) => setList(e.open)), [])

  const run = (r: FixRow, a: FixAction | 'dismiss') => {
    if (busy) return
    track('ui-click', { target: `fix:${r.id}`, detail: { action: a } })
    if (a === 'what') {
      setWhat((w) => (w === r.id ? null : r.id))
      return
    }
    setBusy(a)
    const call =
      a === 'use' ? api.applyFix(r.id) : a === 'undo' ? api.undoFix(r.id) : a === 'redo' ? api.redoFix(ws, r.id) : api.dismissFix(r.id)
    call
      .then(() => {
        if (a === 'use' || a === 'undo') restarting.current = true
        load()
      })
      .catch((e: Error) => bus.emit('toast', { text: failText(a === 'dismiss' ? 'Dismiss' : LABEL[a], e), kind: 'error' }))
      .finally(() => setBusy(null))
  }

  let notice = null
  if (held === 'reload' || (row && reloading(row))) {
    notice = (
      <div className="chat-fix chat-fix-note" role="status" data-kind="reloading" data-fix={row?.id}>
        <Spinner size={12} className="chat-fix-ico" />
        <span className="chat-fix-text">Reloading thimble…</span>
      </div>
    )
  } else if (held === 'typed') {
    notice = (
      <div className="chat-fix chat-fix-note" role="status" data-kind="reload">
        <Icon name="check" size={13} className="chat-fix-ico" />
        <span className="chat-fix-text">thimble started again with your fix. Reload the page to see it; what you typed stays until you do.</span>
        <Button variant="secondary" size="sm" className="chat-fix-act" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    )
  } else if (row) {
    const kind = row.kind ?? 'problem'
    const acts = fixActions(row)
    const said = fixText(row)
    const lead = said.startsWith(FIXED) ? FIXED : ''
    const ask = acts.includes('use')
    const buttons = acts.map((a) => (
      <Button
        key={a}
        variant={a === 'use' ? 'primary' : 'secondary'}
        size="sm"
        className="chat-fix-act"
        data-act={a}
        aria-expanded={a === 'what' ? what === row.id : undefined}
        busy={busy === a}
        disabled={!!busy && busy !== a}
        onClick={() => run(row, a)}
      >
        {LABEL[a]}
      </Button>
    ))
    const dismiss = ask ? null : acts.includes('redo') ? (
      <Button variant="ghost" size="sm" className="chat-fix-act" disabled={!!busy} onClick={() => run(row, 'dismiss')}>
        Dismiss
      </Button>
    ) : (
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-fix-x" disabled={!!busy} onClick={() => run(row, 'dismiss')} />
    )
    notice = (
      <div className={`chat-fix chat-fix-note${ask ? ' chat-fix-ask' : ''}`} role="status" data-fix={row.id} data-kind={kind}>
        <div className="chat-fix-line">
          <Icon name={ICON[kind]} size={13} className="chat-fix-ico" />
          <span className="chat-fix-text">
            {lead && <strong className="chat-fix-lead">{lead}</strong>}
            {lead ? said.slice(lead.length) : said}
          </span>
          {!ask && buttons}
          {dismiss}
        </div>
        {ask && <div className="chat-fix-acts">{buttons}</div>}
        {ask && what === row.id && (
          <dl className="chat-fix-what">
            {changedLines(row).map((l) => (
              <div key={l.label}>
                <dt>{l.label}:</dt>
                <dd>{l.text}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    )
  }
  return (
    <>
      {notice && <div className="chat-fix-top">{notice}</div>}
      {list && <YourFixes onClose={() => setList(false)} onUse={(r) => run(r, r.state === 'on' ? 'undo' : 'use')} busy={!!busy} />}
    </>
  )
}

/** Your fixes: every fix, newest first, with its state; Use it on a ready or off fix, Undo on one that is on. */
function YourFixes({ onClose, onUse, busy }: { onClose: () => void; onUse: (r: FixRow) => void; busy: boolean }) {
  const [rows, setRows] = useState<FixRow[] | null>(null)
  const [why, setWhy] = useState('')
  const load = useCallback(() => {
    api
      .fixes(true)
      .then((s) => {
        setWhy(s.problem)
        setRows(s.fixes)
      })
      .catch((e: Error) => setWhy(e.message.replace(/^\d{3}\s+/, '')))
  }, [])
  useEffect(() => {
    load()
    return bus.on('fix', load)
  }, [load])
  return (
    <div className="chat-fix-top">
      <section className="chat-fixes" aria-label="Your fixes">
        <header className="chat-fixes-head">
          <strong>Your fixes</strong>
          <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
        </header>
        {why ? (
          <p className="chat-fixes-empty">{why}</p>
        ) : rows === null ? (
          <Spinner size={12} label="Loading" />
        ) : rows.length === 0 ? (
          <p className="chat-fixes-empty">No fixes yet. Type /thimble-fix and what should work differently.</p>
        ) : (
          <ul className="chat-fixes-list">
            {rows.map((r) => {
              const can = !r.phase && (r.state === 'ready' || r.state === 'off' || r.state === 'on')
              return (
                <li key={r.id} data-fix={r.id} data-state={r.state}>
                  <span className="chat-fixes-title">{r.title || r.words}</span>
                  <span className="chat-fixes-state">{r.phase ? 'Claude works on it' : (STATE_WORDS[r.state] ?? r.state)}</span>
                  {can && (
                    <Button variant={r.state === 'on' ? 'secondary' : 'primary'} size="sm" disabled={busy} onClick={() => onUse(r)}>
                      {r.state === 'on' ? 'Undo' : 'Use it'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
