// Export: the formats the server offers for the document shown (GET …/exports), each saved as a file (GET
// …/export/{fmt}). A format this machine cannot make (no browser for PDF or video, no ffmpeg) stays in the menu,
// disabled, with the server's reason as its tip. A page's HTML is the page as it is shown, built here as before.
// The Report's Video (`write`) is written from the report first: POST …/report/video starts the video's writer and
// the export after it, whose stage and share rendered the button shows until the file is saved.
import { useEffect, useRef, useState } from 'react'
import { Menu, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { describeDetail } from '../lib/api'
import { frameFonts } from '../lib/frame'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { getResolved } from '../lib/theme'
import { commentsApi } from './commentsApi'
import { pageFile, pageTokens } from './pageFrame'

export interface ExportFormat {
  id: string
  name: string
  ext: string
  ok: boolean
  why?: string
  /** the Report's Video: written from the report before it is exported */
  write?: boolean
}

/** The Report's Video as the server has it (GET …/report/video). */
export interface VideoRun {
  stage: 'writing' | 'rendering' | 'done' | 'failed' | null
  doc: string | null
  progress: number | null
  error: string | null
  name: string | null
}

const POLL_MS = 1500

const base = (ws: string, slug: string) => `/api/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

/** What the button says while the Report's Video runs, or null when it does not. Pure. */
export function videoLabel(run: VideoRun | null): string | null {
  if (run?.stage === 'writing') return 'Writing the video'
  if (run?.stage === 'rendering') return `Rendering the video${run.progress ? ` ${Math.round(run.progress * 100)}%` : ''}`
  return null
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function fail(res: Response): Promise<never> {
  let detail = res.statusText
  try {
    const body = await res.json()
    detail = describeDetail(body.detail ?? body)
  } catch {
    /* the status text stands */
  }
  throw new Error(detail)
}

async function download(ws: string, slug: string, f: ExportFormat, page: boolean) {
  if (page && f.id === 'html') {
    const { html, title } = await commentsApi.exportDoc(ws, slug)
    if (html) return save(new Blob([pageFile(html, title ?? '', getResolved(), pageTokens(), await frameFonts())], { type: 'text/html' }), `${ws}-${slug}.html`)
  }
  const res = await fetch(`${base(ws, slug)}/export/${encodeURIComponent(f.id)}`)
  if (!res.ok) await fail(res)
  save(await res.blob(), res.headers.get('x-export-name') || `${ws}-${slug}.${f.ext}`)
}

async function videoRun(ws: string, init?: RequestInit): Promise<VideoRun> {
  const res = await fetch(`${base(ws, 'report')}/video`, init)
  if (!res.ok) await fail(res)
  return (await res.json()) as VideoRun
}

export function ExportMenu({ ws, slug, page }: { ws: string; slug: string; page: boolean }) {
  const [formats, setFormats] = useState<ExportFormat[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [video, setVideo] = useState<VideoRun | null>(null)
  const timer = useRef<number | null>(null)
  const stop = () => {
    if (timer.current != null) window.clearInterval(timer.current)
    timer.current = null
  }
  // follow the Report's Video until it ends, then save its file
  const follow = () => {
    stop()
    timer.current = window.setInterval(async () => {
      try {
        const run = await videoRun(ws)
        if (run.stage === 'writing' || run.stage === 'rendering') return setVideo(run)
        stop()
        setVideo(null)
        if (run.stage === 'failed') throw new Error(run.error ?? '')
        if (run.stage !== 'done') return
        const res = await fetch(`${base(ws, 'report')}/video/file`)
        if (!res.ok) await fail(res)
        save(await res.blob(), res.headers.get('x-export-name') || run.name || `${ws}-video`)
      } catch (e) {
        stop()
        setVideo(null)
        bus.emit('toast', { text: `Could not export the video. ${(e as Error).message}`.trim(), kind: 'error' })
      }
    }, POLL_MS)
  }
  useEffect(() => {
    if (slug !== 'report') return
    let live = true
    videoRun(ws)
      .then((run) => {
        if (!live || (run.stage !== 'writing' && run.stage !== 'rendering')) return
        setVideo(run)
        follow()
      })
      .catch(() => {})
    return () => {
      live = false
      stop()
      setVideo(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, slug])
  const load = async (open: boolean) => {
    if (!open) return
    try {
      const res = await fetch(`${base(ws, slug)}/exports`)
      if (!res.ok) await fail(res)
      setFormats(((await res.json()) as { formats: ExportFormat[] }).formats)
    } catch (e) {
      setFormats([])
      bus.emit('toast', { text: `Could not list the export formats. ${(e as Error).message}`, kind: 'error' })
    }
  }
  const run = async (f: ExportFormat) => {
    track('ui-click', { target: `report:${slug}`, detail: { action: 'export', format: f.id } })
    if (f.write) {
      try {
        setVideo(await videoRun(ws, { method: 'POST' }))
        follow()
      } catch (e) {
        bus.emit('toast', { text: `Could not export the video. ${(e as Error).message}`, kind: 'error' })
      }
      return
    }
    setBusy(f.name)
    try {
      await download(ws, slug, f, page)
    } catch (e) {
      bus.emit('toast', { text: `Could not export ${f.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const running = videoLabel(video)
  const items: MenuItem[] = (formats ?? []).map((f) => ({
    id: f.id,
    label: f.name,
    note: `.${f.ext}`,
    disabled: !f.ok || busy != null || (f.write === true && running != null),
    tip: f.ok ? undefined : f.why,
    onSelect: () => void run(f),
  }))
  const label = running ?? (busy ? `Exporting ${busy}` : null)
  return (
    <Menu
      label="Export"
      align="end"
      onOpenChange={(o) => void load(o)}
      items={items.length ? items : [{ id: 'loading', heading: formats ? 'No formats' : 'Loading' }]}
      trigger={
        <button type="button" className="wu-export" aria-busy={label != null}>
          {label ? <Spinner size={12} label={label} /> : null}
          {label ?? 'Export'}
        </button>
      }
    />
  )
}
