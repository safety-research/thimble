// The one row above the composer that says how the person's newest fix goes (backend fixes.py, chat/fix.ts): while
// Claude works on it, a spinner and what it does now (fixing, testing, putting it on, restarting); once it ended, how,
// until dismissed: "✓ thimble fixed: <title> · tests pass" with Undo, or why it did not pass with Redo, and ×. After the
// restart a fix asks for, the page loads the new build by itself when nothing typed would be lost.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { servedBuild, thisBuild } from '../lib/chunkRecovery'
import { track } from '../lib/telemetry'
import { fixActions, fixText, type FixRow } from './fix'

const ICON = { fixed: 'check', undone: 'undo', request: 'flag', failed: 'warning', problem: 'warning' } as const

/** Whether the page holds typed text a reload would lose. */
function typing(): boolean {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type=text]')).some((el) => el.value.trim() !== '')
}

export function FixStrip({ ws }: { ws: string }) {
  const [row, setRow] = useState<FixRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const restarting = useRef(false)
  const load = useCallback(() => {
    api
      .fixes()
      .then((s) => {
        const top = s.fixes[0] ?? null
        if (top?.phase === 'restarting') restarting.current = true
        setRow(top)
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    const offFix = bus.on('fix', load)
    const offStream = bus.on('wsStream', (e) => {
      if (!e.connected) return
      load()
      if (!restarting.current) return
      // the server came back from the restart a fix asked for: the page loads its new build
      void Promise.all([thisBuild(), servedBuild()]).then(([a, b]) => {
        if (a && b && a !== b && !typing()) window.location.reload()
      })
    })
    return () => {
      offFix()
      offStream()
    }
  }, [load])
  if (!row) return null
  const run = (what: 'undo' | 'redo' | 'dismiss') => {
    if (busy) return
    track('ui-click', { target: `fix:${row.id}`, detail: { action: what } })
    setBusy(what)
    const call = what === 'undo' ? api.undoFix(row.id) : what === 'redo' ? api.redoFix(ws, row.id) : api.dismissFix(row.id)
    call
      .then(() => {
        if (what === 'undo') restarting.current = true
        load()
      })
      .catch((e: Error) => bus.emit('toast', { text: `${what === 'undo' ? 'Undo' : what === 'redo' ? 'Redo' : 'Dismiss'} didn't work: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const kind = row.phase ? 'working' : (row.kind ?? 'problem')
  const acts = fixActions(row)
  return (
    <div className="chat-fix" role="status" data-fix={row.id} data-kind={kind} data-phase={row.phase ?? undefined}>
      {row.phase ? <Spinner size={12} className="chat-fix-ico" /> : <Icon name={ICON[row.kind ?? 'problem']} size={13} className="chat-fix-ico" />}
      <span className="chat-fix-text">{fixText(row)}</span>
      {acts.map((a) => (
        <Button key={a} variant="secondary" size="sm" className="chat-fix-act" busy={busy === a} disabled={!!busy && busy !== a} onClick={() => run(a)}>
          {a === 'undo' ? 'Undo' : 'Redo'}
        </Button>
      ))}
      {!row.phase && (acts.includes('redo') ? (
        <Button variant="ghost" size="sm" className="chat-fix-act" disabled={!!busy} onClick={() => run('dismiss')}>
          Dismiss
        </Button>
      ) : (
        <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-fix-x" disabled={!!busy} onClick={() => run('dismiss')} />
      ))}
    </div>
  )
}
