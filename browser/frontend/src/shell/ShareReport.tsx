// Report a problem with thimble (backend issues.py). Three ways in, one flow: Fix this / Report this on a failure line
// or an error toast (ReportThis, the bus's `reportThis`), a failure's Report a problem (the bus's `reportProblem`), and
// Report a problem… in the settings menu, with nothing written in. Each sends main a message; the chat agent drafts the
// issue with draft_report, the server scans it and the stream's `issue` record opens this preview.
//
// The preview shows the exact text the issue would carry, each placeholder of a removed detail marked; beside it the
// privacy scan's hits, each with Keep (never for a key or a token). Not now closes it; Edit changes the text and the
// scan runs again; Save as file downloads one Markdown file; Send opens the issue under the person's own GitHub
// login. Only these clicks answer the preview: they carry the ask id, which the agent never sees. thimble browser does
// not change thimble's code itself, so Fix this drafts a report too and the preview says so in one line.
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { apiBase } from '../lib/browserKey'
import { bus } from '../lib/bus'

export interface ScanHit {
  id: string
  kind: string
  found: string
  replacement: string
  kept: boolean
  keepable: boolean
}

export interface IssueDraft {
  slug: string
  title: string
  text: string
  draft: string
  hits: ScanHit[]
  ask: string
  repo: string
  login?: string | null
}

export const FIX_LINE = 'thimble browser does not change thimble’s code: fixes are made from the terminal plugin for now, so this is a report.'
export const NEVER = ['your files, their names and folders', 'record values, names, emails', 'chats, transcripts and cards', 'keys and tokens (no Keep)']

/** What a hit is, as the scan column names it. Pure. */
export function hitKind(kind: string): string {
  return (
    {
      path: 'home folder path',
      email: 'email',
      file: 'file name from your folder',
      folder: 'folder name from your folder',
      field: 'field name from your files',
      value: 'value from your files',
      name: 'your name',
      git: 'your git name',
      host: 'host name or address',
      token: 'key or token',
      key: 'private key',
      generic: 'secret',
    } as Record<string, string>
  )[kind] ?? kind
}

/** The message main gets for a Fix this or Report this on `text`, or for Report a problem… with nothing. Pure. */
export function reportMessage(mode: 'fix' | 'report', text: string): string {
  const what = text.trim()
  if (!what) return 'I want to report a problem with thimble. Ask me what happened, then draft the report.'
  return mode === 'fix' ? `Fix this problem in thimble: ${what}` : `Report this problem with thimble: ${what}`
}

/** The text cut into plain runs and marked runs, each mark a replacement of a removed hit. Pure. */
export function markPieces(text: string, marks: readonly string[]): { text: string; mark: boolean }[] {
  const wanted = [...new Set(marks.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!wanted.length) return [{ text, mark: false }]
  const rx = new RegExp(wanted.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const out: { text: string; mark: boolean }[] = []
  let at = 0
  for (const m of text.matchAll(rx)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), mark: false })
    out.push({ text: m[0], mark: true })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false })
  return out
}

const enc = encodeURIComponent

async function call<T>(ws: string, path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}/ws/${enc(ws)}/issues${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fix this and Report this after a failure's words: each sends main the failure to report. */
export function ReportThis({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`report-this ${className}`}>
      <button type="button" className="report-this-btn report-this-fix" onClick={(e) => { e.stopPropagation(); bus.emit('reportThis', { mode: 'fix', text }) }}>
        Fix this
      </button>
      <button type="button" className="report-this-btn" onClick={(e) => { e.stopPropagation(); bus.emit('reportThis', { mode: 'report', text }) }}>
        Report this
      </button>
    </span>
  )
}

/** The preview itself, for one draft. */
export function ShareReportDialog({ ws, draft: first, fix = false, onClose }: { ws: string; draft: IssueDraft; fix?: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(first)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const login = first.login
  const removed = draft.hits.filter((h) => !h.kept)
  const act = async (what: string, run: () => Promise<void>) => {
    setBusy(what)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(`${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const keep = (h: ScanHit) =>
    act(`keep:${h.id}`, async () => setDraft(await call<IssueDraft>(ws, `/${draft.slug}/keep`, 'POST', { hit: h.id, keep: !h.kept, ask: draft.ask })))
  const saveEdit = () =>
    act('edit', async () => {
      setDraft(await call<IssueDraft>(ws, `/${draft.slug}`, 'PUT', { text: editing, ask: draft.ask }))
      setEditing(null)
    })
  const saveFile = () =>
    act('file', async () => {
      const r = await call<{ markdown: string; filename: string }>(ws, `/${draft.slug}/send`, 'POST', { answer: 'file', ask: draft.ask })
      download(r.filename, r.markdown)
      bus.emit('toast', { text: `Saved ${r.filename} to your downloads. Nothing was sent.` })
      onClose()
    })
  const send = () =>
    act('send', async () => {
      const r = await call<{ url?: string }>(ws, `/${draft.slug}/send`, 'POST', { answer: 'send', ask: draft.ask })
      bus.emit('toast', { text: `Sent as an issue: ${r.url ?? ''}` })
      onClose()
    })
  const pieces = markPieces(draft.text, removed.map((h) => h.replacement))
  return (
    <div className="share-scrim" role="presentation" onClick={onClose}>
      <div className="share-dialog" role="dialog" aria-modal="true" aria-label="Share this report" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <h2>Share this report</h2>
          <p>
            Nothing has been sent. GitHub receives exactly this text: an issue on {draft.repo}, from {login ? `your login @${login}` : 'your GitHub login'}.
          </p>
          {fix && <p className="share-fixline">{FIX_LINE}</p>}
        </header>
        <div className="share-body">
          <div className="share-main">
            <div className="share-tabs" role="tablist">
              <span role="tab" aria-selected="true" className="share-tab on">Issue</span>
            </div>
            {editing != null ? (
              <textarea className="share-text share-edit" aria-label="The issue text" value={editing} onChange={(e) => setEditing(e.target.value)} />
            ) : (
              <pre className="share-text" data-testid="share-text">
                {pieces.map((p, i): ReactNode => (p.mark ? <mark key={i} className="share-ph">{p.text}</mark> : p.text))}
              </pre>
            )}
          </div>
          <aside className="share-scan" aria-label="Privacy scan">
            <h3>Privacy scan</h3>
            <p className="share-scan-sum">
              {draft.hits.length === 0
                ? 'nothing found in this text'
                : `${draft.hits.length} found in this text · ${removed.length === draft.hits.length ? 'all removed' : `${removed.length} removed, ${draft.hits.length - removed.length} kept`}`}
            </p>
            <ul className="share-hits">
              {draft.hits.map((h) => (
                <li key={h.id} className={`share-hit${h.kept ? ' kept' : ''}`} data-kind={h.kind}>
                  <div className="share-hit-top">
                    <span className="share-hit-kind">{hitKind(h.kind)}</span>
                    {h.keepable ? (
                      <button type="button" className="share-keep" disabled={!!busy || editing != null} onClick={() => void keep(h)}>
                        {h.kept ? 'Remove' : 'Keep'}
                      </button>
                    ) : (
                      <span className="share-never">never sent</span>
                    )}
                  </div>
                  <div className="share-hit-what">
                    <s>{h.found}</s> → <code>{h.kept ? h.found : h.replacement}</code>
                  </div>
                </li>
              ))}
            </ul>
            <h4>Never included</h4>
            <ul className="share-never-list">
              {NEVER.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </aside>
        </div>
        <footer className="share-foot">
          <span className={`share-foot-note${error ? ' share-error' : ''}`} role={error ? 'alert' : undefined}>
            {error ?? 'Edit, and the scan runs again. Only your click sends.'}
          </span>
          <Button variant="secondary" onClick={onClose} disabled={busy === 'send'}>
            Not now
          </Button>
          {editing != null ? (
            <Button variant="secondary" busy={busy === 'edit'} onClick={() => void saveEdit()}>
              Scan again
            </Button>
          ) : (
            <Button variant="secondary" disabled={!!busy} onClick={() => setEditing(draft.text)}>
              Edit
            </Button>
          )}
          <Button variant="secondary" busy={busy === 'file'} disabled={!!busy || editing != null} onClick={() => void saveFile()}>
            Save as file
          </Button>
          <Button variant="primary" busy={busy === 'send'} disabled={!!busy || editing != null} onClick={() => void send()}>
            Send
          </Button>
        </footer>
      </div>
    </div>
  )
}

/** Where the flow lives in the page: it sends main the report request and opens the preview when a draft is ready. */
export function ShareReportHost({ ws }: { ws: string }) {
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [fix, setFix] = useState(false)
  useEffect(() => {
    const start = (mode: 'fix' | 'report', text: string) => {
      setFix(mode === 'fix')
      bus.emit('openChat', { chatId: 'main', send: reportMessage(mode, text) })
    }
    const offs = [
      bus.on('reportThis', (p) => start(p.mode, p.text)),
      bus.on('reportProblem', (p) => start('report', p.description)),
      bus.on('wsEvent', (ev) => {
        if (ev.type !== 'issue') return
        call<IssueDraft | null>(ws, '/current', 'GET')
          .then((d) => d && setDraft(d))
          .catch((e: Error) => bus.emit('toast', { text: `The report's preview did not open: ${e.message}. Ask Claude to draft it again.`, kind: 'error' }))
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [ws])
  if (!draft) return null
  return <ShareReportDialog key={draft.slug} ws={ws} draft={draft} fix={fix} onClose={() => setDraft(null)} />
}
