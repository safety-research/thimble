// Fix thimble from the browser (backend fixcopy.py and issues.py), the same steps as the terminal's /thimble:fix:
// describe what to change -> Claude changes a copy of thimble and turns it on (Try it, Undo) -> Submit opens the
// review (ShareReport) -> Send or Save as file.
//
// FixButton is the top bar's Fix…: a small sheet asks what thimble should do differently and sends `/fix <text>` to
// main, as typing it in the chat does. FixState is the line beside it for this workspace's newest fix: Try it and
// Submit once Claude made it. Try it restarts thimble browser from the fix's copy and reloads the page; then the line
// says `✓ fixed` with Submit and Undo, and Undo restarts it from the release (backend restart.py). While Claude works on
// the fix, and while a restart runs, the busy line above the chat's input box says so (`fixing: <title>`, `restarting
// with the fix`, lib/busy.ts); the top bar shows no word of its own then.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Popover } from '../components/Menu'
import { apiBase, apiUrl } from '../lib/browserKey'
import { bus } from '../lib/bus'
import { pageJob } from '../lib/busy'

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

/** The busy line's step for a fix Claude works on, or null. Pure. */
export function fixStep(f: FixRow | null): string | null {
  return f?.status === 'working' ? `fixing: ${f.title.length > 32 ? `${f.title.slice(0, 31)}…` : f.title}` : null
}

/** What the line says of a fix and which actions it offers (none while Claude works on it: the busy line says so). Pure. */
export function fixLine(f: FixRow | null, active: string | null): { words: string; good?: boolean; actions: ('try' | 'undo' | 'submit')[] } | null {
  if (!f || ['dropped', 'merged', 'working'].includes(f.status)) return null
  const shared = f.status === 'sent' || f.status === 'saved'
  // `active` is the fix this browser runs (Try it restarts the server from its copy); a shared fix keeps only Undo
  if (active === f.slug) return { words: `✓ fixed: ${f.title}${shared ? ` · ${f.status}` : ''}`, good: true, actions: shared ? ['undo'] : ['submit', 'undo'] }
  return shared ? null : { words: f.title, actions: ['try', 'submit'] }
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

async function bootId(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl('/api/health'), { cache: 'no-store' })
    return res.ok ? (((await res.json()) as { boot?: string }).boot ?? null) : null
  } catch {
    return null
  }
}

/** Waits until the server answers with a boot id other than `before` (a restart is done), for at most two minutes. */
async function waitForRestart(before: string | null): Promise<void> {
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => window.setTimeout(r, 500))
    const now = await bootId()
    if (now && now !== before) return
  }
}

export function FixState({ ws }: { ws: string }) {
  const [state, setState] = useState<{ fixes: FixRow[]; active: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [boot, setBoot] = useState<string | null>(null)
  useEffect(() => {
    void bootId().then(setBoot)
  }, [])
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
  const step = fixStep(f)
  useEffect(() => {
    pageJob('fix:working', step)
    return () => pageJob('fix:working', null)
  }, [step])
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
      const r = await call<{ fixes: FixRow[]; active: string | null; said: string; restarting?: boolean }>(ws, what === 'try' ? `/fixes/${enc(f.slug)}/use` : '/fixes/undo', 'POST')
      bus.emit('toast', { text: r.said })
      if (r.restarting) {
        // the server restarts from the fix's copy (or the release): reload the page once the new one answers. The
        // busy line says so meanwhile, a step of the page's own, which the dropped stream does not clear
        pageJob('fix:restart', what === 'try' ? 'restarting with the fix' : 'restarting without the fix')
        await waitForRestart(boot)
        window.location.reload()
        return
      }
      setState(r)
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
