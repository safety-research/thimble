// Export: the formats the server offers for the document shown (GET …/exports), each saved as a file (GET
// …/export/{fmt}). A format this machine cannot make (no browser for PDF) stays in the menu,
// disabled, with the server's reason as its tip. A page's HTML is the page as it is shown, built here as before.
// Claude artifact publishes the document (POST …/export/artifact, backend artifact_export.py): main publishes its page
// with Claude Code's Artifact tool while Export says it is exporting, and the artifact's link comes in a toast. Where
// nothing is published, a notice says why and the artifact page downloads in its place.
import { useState } from 'react'
import { Menu, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { describeDetail, signInNeeded } from '../lib/api'
import { apiBase } from '../lib/browserKey'
import { frameFonts } from '../lib/frame'
import { bus, type Events } from '../lib/bus'
import { isReplay } from '../lib/events'
import { track } from '../lib/telemetry'
import { getResolved } from '../lib/theme'
import { commentsApi } from './commentsApi'
import { pageFile, pageTokens } from './pageFrame'

export interface ExportFormat {
  id: string
  name: string
  ext: string
  /** what the menu notes beside the name in place of `.ext`: `link` for a Claude artifact */
  note?: string
  ok: boolean
  why?: string
}

const base = (ws: string, slug: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

/** `blob` saved as the file `name`, as a download the browser makes. */
export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A failed answer as the error it throws: the server's detail, else the status text. */
export async function fail(res: Response): Promise<never> {
  await signInNeeded(res)
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

/** The end of the export of document `doc` as a Claude artifact (the stream's `export` record), however long main takes
 * and whether or not the menu is still shown; `stop` stops waiting. */
function awaitEnd(doc: string): { end: Promise<Events['export']>; stop: () => void } {
  let off = () => {}
  const end = new Promise<Events['export']>((done) => {
    off = bus.on('export', (e) => {
      if (e.doc !== doc || e.format !== 'artifact' || isReplay()) return
      off()
      done(e)
    })
  })
  return { end, stop: () => off() }
}

/** Export, Claude artifact: main publishes the document, and its link comes in a toast that says the artifact is
 * private, as Claude Code makes it, and promises no sharing, which the person's claude.ai settings decide; when nothing
 * is published, the artifact page downloads, and the notice the server posts says why. */
async function publish(ws: string, slug: string, f: ExportFormat) {
  const waiting = awaitEnd(slug) // before the request, so no end is missed
  try {
    const res = await fetch(`${base(ws, slug)}/export/artifact`, { method: 'POST', headers: { 'content-type': 'application/json' } })
    if (!res.ok) await fail(res)
    const { publishing } = (await res.json()) as { publishing: boolean }
    const done = publishing ? await waiting.end : null
    if (done?.status === 'published' && done.link) {
      bus.emit('toast', { text: 'Published as a private Claude artifact', link: { href: done.link, label: done.link.replace(/^https?:\/\//, '') } })
      return
    }
  } finally {
    waiting.stop()
  }
  await download(ws, slug, f, false)
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
      await (f.id === 'artifact' ? publish(ws, slug, f) : download(ws, slug, f, page))
    } catch (e) {
      bus.emit('toast', { text: `Could not export ${f.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const items: MenuItem[] = (formats ?? []).map((f) => ({
    id: f.id,
    label: f.name,
    note: f.note ?? `.${f.ext}`,
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
