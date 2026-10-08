// The top bar's Report a problem dialog. The form takes a description, an optional screenshot of this tab
// (getDisplayMedia) and optionally the logs. Prepare bundle asks the server to write a zip (POST /ws/{c}/feedback) with
// the tab's recent console errors and failed requests; the dialog then offers Download, Copy path, Show in folder and
// Open a GitHub issue, prefilled by the server without the logs. The dialog hides itself while the tab is captured.
// In a development install (GET /dev/status says code tickets run here) the form also offers File a code ticket, which
// files the description as a ticket for thimble's developer agent (POST /dev/tickets, the analyst's click, which starts
// the agent as a subagent of their Claude Code session) and opens the ticket's thread.
//
// Where something fails, ReportProblemButton opens the same dialog through the bus with the failure written in.
import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { Button } from '../components/Button'
import { TextArea } from '../components/Field'
import { Mark } from '../components/Marks'
import { Popover } from '../components/Menu'
import { api, feedbackApi } from '../lib/api'
import { openThread } from '../chat/Notes'
import { bus, type ProblemPrefill } from '../lib/bus'
import { recentProblems } from '../lib/problemLog'
import type { ProblemReport, ProblemReportBody } from '../lib/types'

export const LOGS_NOTE = "The logs contain parts of your data and Claude's answers, so share them only with people you trust."
/** The longest data URL a PNG is sent as; a bigger picture goes as a JPEG (the server takes up to 5 MB). */
export const PNG_MAX_CHARS = 6_000_000
/** How long the hidden dialog waits before the frame is taken, so the capture does not show it. */
const HIDE_MS = 300

export interface Piece {
  text: string
  href?: string
}

/** The sentence cut into pieces, each place it names a link's text becoming that link, in the order they appear. Pure. */
export function linkPieces(sentence: string, links: readonly { text: string; href: string }[]): Piece[] {
  const out: Piece[] = []
  let rest = sentence
  for (;;) {
    const hits = links.map((l) => ({ l, at: l.text ? rest.indexOf(l.text) : -1 })).filter((h) => h.at >= 0)
    if (!hits.length) break
    const first = hits.reduce((a, b) => (b.at < a.at ? b : a))
    if (first.at > 0) out.push({ text: rest.slice(0, first.at) })
    out.push({ text: first.l.text, href: first.l.href })
    rest = rest.slice(first.at + first.l.text.length)
  }
  if (rest) out.push({ text: rest })
  return out
}

/** A code ticket's title from what the analyst wrote: its first line that has words, at most TITLE_CHARS long. Pure. */
export const TITLE_CHARS = 80
export function ticketTitle(description: string): string {
  const first = description.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1).trimEnd()}…` : first
}

/** Open the prefilled new issue in a new tab, with no handle back to this page. */
export function openIssue(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** One frame of this tab as a data URL, or null when the browser cannot capture it or the analyst says no. */
export async function captureTab(hide: (on: boolean) => void): Promise<string | null> {
  const md = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: (o?: object) => Promise<MediaStream> }) | undefined
  if (!md?.getDisplayMedia) return null
  let stream: MediaStream
  try {
    // Chromium offers this tab first with preferCurrentTab; other browsers ignore the options they do not know
    stream = await md.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' })
  } catch {
    return null
  }
  try {
    hide(true)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    await new Promise((r) => window.setTimeout(r, HIDE_MS))
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')?.drawImage(video, 0, 0, w, h)
    const png = canvas.toDataURL('image/png')
    return png.length <= PNG_MAX_CHARS ? png : canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return null
  } finally {
    stream.getTracks().forEach((t) => t.stop())
    hide(false)
  }
}

/** Put `text` on the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // a page the browser does not trust with the clipboard API: fall back to the copy command on a selected field
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

/** Open Report a problem with what failed written in (TopBar listens). */
export function reportProblem(description: string, focus: readonly string[] = []): void {
  bus.emit('reportProblem', { description, focus: focus.filter(Boolean) })
}

/** The description a failure writes in: what failed, and its error on the next line when it has one. Pure. */
export function failureText(what: string, error?: string | null): string {
  const why = (error ?? '').trim()
  return why ? `${what}\n${why}` : what
}

/** Report a problem where something failed: text beside the failure, or the bug alone where room is short. */
export function ReportProblemButton({ description, focus, compact = false, className }: { description: string; focus?: readonly string[]; compact?: boolean; className?: string }) {
  const open = (e: MouseEvent) => {
    e.stopPropagation()
    reportProblem(description, focus ?? [])
  }
  return compact ? (
    <Button variant="icon" size="sm" icon="bug" title="Report a problem" aria-label="Report a problem" className={className} onClick={open} data-tel="report-problem-here" />
  ) : (
    <Button size="sm" icon="bug" className={className} onClick={open} data-tel="report-problem-here">
      Report a problem
    </Button>
  )
}

export function ProblemReportPopover({ ws, anchor, open, onClose, prefill = null }: { ws: string; anchor: HTMLElement | null; open: boolean; onClose: () => void; prefill?: ProblemPrefill | null }) {
  const [description, setDescription] = useState('')
  const [shot, setShot] = useState(false)
  const [logs, setLogs] = useState(true)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ProblemReport | null>(null)
  const [copied, setCopied] = useState(false)
  // whether code tickets run here (a development install), asked each time the dialog opens
  const [tickets, setTickets] = useState(false)
  const [filing, setFiling] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    api
      .devStatus()
      .then((s) => alive && setTickets(s.tickets === ''))
      .catch(() => alive && setTickets(false))
    return () => {
      alive = false
    }
  }, [open])

  // opened from a failure, the form starts with what failed
  useEffect(() => {
    if (open && prefill) setDescription(prefill.description)
  }, [open, prefill])

  // a closed dialog opens on a fresh form
  useEffect(() => {
    if (open) return
    setDescription('')
    setShot(false)
    setLogs(true)
    setBusy(false)
    setError(null)
    setDone(null)
    setCopied(false)
  }, [open])

  const prepare = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const screenshot = shot ? await captureTab(setHidden) : null
      const body: ProblemReportBody = { description, screenshot, screenshot_asked: shot, logs, user_agent: navigator.userAgent, browser: logs ? recentProblems() : [], focus: prefill?.focus ?? [] }
      setDone(await feedbackApi.prepare(ws, body))
    } catch (e) {
      setError(`The bundle could not be written: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [ws, description, shot, logs, prefill])

  // the description as a ticket for thimble's developer agent: a click, which starts its agent; the dialog closes on the
  // ticket's thread
  const fileTicket = useCallback(async () => {
    setFiling(true)
    setError(null)
    try {
      const t = await api.fileTicket({ workspace: ws, title: ticketTitle(description), body: description.trim(), source: 'ui' })
      if (t.chat) openThread(t.chat, 'file-ticket')
      onClose()
    } catch (e) {
      setError(`The ticket could not be filed: ${(e as Error).message}`)
    } finally {
      setFiling(false)
    }
  }, [ws, description, onClose])

  const copy = async () => {
    if (!done) return
    if (await copyText(done.path)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
  }
  // the zip through the browser, which may run on another machine than the server (a tunnel)
  const download = () => {
    if (!done) return
    const a = document.createElement('a')
    a.href = feedbackApi.downloadUrl(done.path)
    a.download = done.name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  const reveal = async () => {
    if (!done) return
    try {
      await feedbackApi.reveal(done.path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" label="Report a problem" className={`problem-pop${hidden ? ' is-capturing' : ''}`} width={340}>
      {done ? (
        <div className="problem" data-panel="problem" data-state="done">
          <div className="problem-ready" role="status">
            <Mark kind="verified" label="ready" />
            <span>Bundle ready, {done.size}</span>
          </div>
          <div className="problem-path">{done.path}</div>
          {done.screenshot_missing && <p className="problem-note">The screenshot was not captured, so the bundle has none.</p>}
          <div className="problem-actions">
            <Button size="sm" variant="secondary" onClick={download}>
              Download
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy path'}
            </Button>
            {done.can_reveal && (
              <Button size="sm" variant="secondary" onClick={() => void reveal()}>
                Show in folder
              </Button>
            )}
          </div>
          <p className="problem-send">
            {linkPieces(done.instructions, [{ text: done.contact, href: done.contact_url }]).map((p, i) =>
              p.href ? (
                <a key={i} href={p.href} target="_blank" rel="noreferrer">
                  {p.text}
                </a>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </p>
          {error && <div className="problem-error">{error}</div>}
          <div className="problem-foot">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <Button variant="primary" onClick={() => openIssue(done.issue_url)} data-tel="open-github-issue">
              Open a GitHub issue
            </Button>
          </div>
        </div>
      ) : (
        <div className="problem" data-panel="problem" data-state="form">
          <label className="problem-label" htmlFor="problem-description">
            What went wrong?
          </label>
          <TextArea id="problem-description" block rows={4} value={description} onChange={setDescription} disabled={busy} autoFocus />
          <label className="problem-check">
            <input type="checkbox" checked={shot} onChange={(e) => setShot(e.target.checked)} disabled={busy} />
            <span>Include a screenshot of this tab</span>
          </label>
          <label className="problem-check">
            <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} disabled={busy} />
            <span>Include logs</span>
          </label>
          <p className="problem-note">{LOGS_NOTE}</p>
          {error && <div className="problem-error">{error}</div>}
          <div className="problem-foot">
            <Button variant="ghost" onClick={onClose} disabled={busy || filing}>
              Cancel
            </Button>
            {tickets && (
              <Button variant="secondary" busy={filing} disabled={busy || !description.trim()} onClick={() => void fileTicket()} data-tel="file-code-ticket" title="thimble's developer agent works on it in a copy of thimble's code, and asks you before the change reaches thimble">
                File a code ticket
              </Button>
            )}
            <Button variant="primary" busy={busy} disabled={filing} onClick={() => void prepare()}>
              Prepare bundle
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}
