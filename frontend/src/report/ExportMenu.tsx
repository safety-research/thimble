// Export: the formats the server offers for the document shown (GET …/exports), each saved as a file (GET
// …/export/{fmt}). A format this machine cannot make (no browser for PDF or video, no ffmpeg) stays in the menu,
// disabled, with the server's reason as its tip. A page's HTML is the page as it is shown, built here as before.
import { useState } from 'react'
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
}

const base = (ws: string, slug: string) => `/api/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

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

export function ExportMenu({ ws, slug, page }: { ws: string; slug: string; page: boolean }) {
  const [formats, setFormats] = useState<ExportFormat[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
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
    setBusy(f.name)
    try {
      await download(ws, slug, f, page)
    } catch (e) {
      bus.emit('toast', { text: `Could not export ${f.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const items: MenuItem[] = (formats ?? []).map((f) => ({
    id: f.id,
    label: f.name,
    note: `.${f.ext}`,
    disabled: !f.ok || busy != null,
    tip: f.ok ? undefined : f.why,
    onSelect: () => void run(f),
  }))
  return (
    <Menu
      label="Export"
      align="end"
      onOpenChange={(o) => void load(o)}
      items={items.length ? items : [{ id: 'loading', heading: formats ? 'No formats' : 'Loading' }]}
      trigger={
        <button type="button" className="wu-export" aria-busy={busy != null}>
          {busy ? <Spinner size={12} label={`Exporting ${busy}`} /> : null}
          {busy ? `Exporting ${busy}` : 'Export'}
        </button>
      }
    />
  )
}
