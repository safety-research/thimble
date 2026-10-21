// Fix thimble from the browser (backend fixcopy.py and issues.py), the same steps as the terminal's /thimble:fix:
// describe what to change -> Claude changes a copy of thimble and turns it on (Try it, Undo) -> Submit opens the
// review (ShareReport) -> Send or Save as file.
//
// FixButton is the top bar's Fix…: a small sheet asks what thimble should do differently and sends `/fix <text>` to
// main, as typing it in the chat does. FixState is the line beside it for this workspace's newest fix: `fixing` while
// Claude works, then `✓ fixed` with Submit and Undo while the copy is on, or Try it and Submit while it is off.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Popover } from '../components/Menu'
import { apiBase } from '../lib/browserKey'
import { bus } from '../lib/bus'

export interface FixRow {
  slug: string
  title: string
  status: string
  pr_url?: string | null
  issue_url?: string | null
}

const enc = encodeURIComponent

async function call<T>(ws: string, path: string, method = 'GET'): Promise<T> {
  const res = await fetch(`${apiBase()}/ws/${enc(ws)}${path}`, { method })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = String((await res.json()).detail ?? detail)
    } catch {
      /* the status text stands */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

/** The message main gets for the top bar's Fix…: the same words as `/fix` typed in the chat. Pure. */
export function fixMessage(text: string): string {
  return `/fix ${text.replace(/\s+/g, ' ').trim()}`
}

/** What the line says of a fix and which actions it offers. Pure. */
export function fixLine(f: FixRow | null, active: string | null): { words: string; good?: boolean; actions: ('try' | 'undo' | 'submit')[] } | null {
  if (!f || ['sent', 'saved', 'dropped', 'merged'].includes(f.status)) return null
  if (f.status === 'working') return { words: `fixing: ${f.title}`, actions: [] }
  if (active === f.slug || f.status === 'applied') return { words: `✓ fixed: ${f.title}`, good: true, actions: ['submit', 'undo'] }
  return { words: f.title, actions: ['try', 'submit'] }
}

export function FixButton() {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    bus.emit('openChat', { chatId: 'main', send: fixMessage(text) })
    setText('')
    setOpen(false)
  }
  return (
    <>
      <button ref={setAnchor} type="button" className="shell-fix-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-tel="fix">
        Fix…
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Fix thimble" className="shell-fix-sheet" width={420} align="end">
        <form
          className="shell-fix-form"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <label htmlFor="shell-fix-text">What should thimble do differently?</label>
          <textarea id="shell-fix-text" rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Sort the claims newest first" />
          <p className="shell-fix-note">Claude changes a copy of thimble and turns it on for you. Nothing is sent until you submit it and say yes.</p>
          <div className="shell-fix-actions">
            <Button variant="primary" type="submit" disabled={!text.trim()}>
              Make the change
            </Button>
          </div>
        </form>
      </Popover>
    </>
  )
}

export function FixState({ ws }: { ws: string }) {
  const [state, setState] = useState<{ fixes: FixRow[]; active: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => {
    call<{ fixes: FixRow[]; active: string | null }>(ws, '/fixes')
      .then(setState)
      .catch(() => undefined)
  }, [ws])
  useEffect(() => {
    load()
    return bus.on('wsEvent', (ev) => {
      if (ev.type === 'fix' || ev.type === 'issue' || ev.type === 'chat') load()
    })
  }, [load])
  const f = state?.fixes.at(-1) ?? null
  const line = fixLine(f, state?.active ?? null)
  if (!f || !line) return null
  const act = async (what: 'try' | 'undo' | 'submit') => {
    if (what === 'submit') {
      // a draft that waits opens at once; else Claude writes it, and the review opens when it is ready
      const waiting = await call<{ slug: string } | null>(ws, '/issues/current').catch(() => null)
      if (waiting?.slug === f.slug) bus.emit('wsEvent', { type: 'issue', slug: f.slug })
      else bus.emit('openChat', { chatId: 'main', send: '/fix submit' })
      return
    }
    setBusy(what)
    try {
      const r = await call<{ fixes: FixRow[]; active: string | null; said: string }>(ws, what === 'try' ? `/fixes/${enc(f.slug)}/use` : '/fixes/undo', 'POST')
      setState(r)
      bus.emit('toast', { text: r.said })
    } catch (e) {
      bus.emit('toast', { text: `${what === 'try' ? 'The fix was not turned on' : 'The fix was not undone'}: ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const label = { try: 'Try it', undo: 'Undo', submit: 'Submit' } as const
  return (
    <span className={`shell-fix-state${line.good ? ' good' : ''}`} data-testid="fix-state">
      <span className="shell-fix-words" title={f.title}>
        {line.words}
      </span>
      {line.actions.map((a) => (
        <button key={a} type="button" className="shell-fix-act" disabled={!!busy} onClick={() => void act(a)} data-fix-action={a}>
          {label[a]}
        </button>
      ))}
    </span>
  )
}
