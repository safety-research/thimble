// Export: the formats the server offers for the document shown (GET …/exports), each saved as a file (GET
// …/export/{fmt}). A format this machine cannot make stays in the menu, disabled, with the server's reason as its tip.
// For a format that takes pictures (thimble browser's HTML and PDF), each figure is drawn here as the report shows it and sent with the request (POST …/export/{fmt}), so
// the file's figures look as they do on the page; a figure that cannot be drawn is the server's table or text. PDF
// (`print`) is that HTML printed by this browser: its print dialog saves the PDF.
import { useState } from 'react'
import { Menu, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { describeDetail, signInNeeded } from '../lib/api'
import { apiBase } from '../lib/browserKey'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'

export interface ExportFormat {
  id: string
  name: string
  ext: string
  ok: boolean
  why?: string
  /** the server draws the figures from pictures this page sends */
  pictures?: boolean
  /** the file is the HTML this browser prints (its print dialog saves a PDF) */
  print?: boolean
}

/** The most figures drawn for one export. */
const PICTURES_MAX = 60

/** Each figure the report shows, drawn as a PNG data URL, by its card's id: the figure's body (its chart, table or
 * text), without its question and caption, which the export writes itself. */
export async function figurePictures(root: ParentNode = document): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const figs = Array.from(root.querySelectorAll<HTMLElement>('.wu-report figure.wu-fig[data-anchor]')).slice(0, PICTURES_MAX)
  const { capturePng } = await import('../pointer/capture')
  for (const fig of figs) {
    // a figure's anchor is its card's id, or `card:<id>`
    const id = (fig.getAttribute('data-anchor') ?? '').replace(/^(card|cell):/, '')
    const body = fig.querySelector<HTMLElement>('.wu-fig-body')
    if (!id || !body || out[id]) continue
    const png = await capturePng(body)
    if (png) out[id] = png
  }
  return out
}

/** Print an HTML file in a frame of this page: the browser's print dialog, where Save as PDF makes the file. The frame
 * runs no script of its own. */
function printHtml(html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none'
  frame.onload = () => {
    window.setTimeout(() => {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
      window.setTimeout(() => frame.remove(), 60_000)
    }, 300)
  }
  frame.srcdoc = html
  document.body.appendChild(frame)
}

const base = (ws: string, slug: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function fail(res: Response): Promise<never> {
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

async function download(ws: string, slug: string, f: ExportFormat) {
  const res = f.pictures
    ? await fetch(`${base(ws, slug)}/export/${encodeURIComponent(f.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pictures: await figurePictures() }) })
    : await fetch(`${base(ws, slug)}/export/${encodeURIComponent(f.id)}`)
  if (!res.ok) await fail(res)
  if (f.print) return printHtml(await res.text())
  save(await res.blob(), res.headers.get('x-export-name') || `${ws}-${slug}.${f.ext}`)
}

export function ExportMenu({ ws, slug }: { ws: string; slug: string }) {
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
      await download(ws, slug, f)
    } catch (e) {
      bus.emit('toast', { text: `Could not export ${f.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const items: MenuItem[] = (formats ?? []).map((f) => ({
    id: f.id,
    label: f.name,
    note: f.print ? 'print' : `.${f.ext}`,
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
