// Export on a card's hover row: the files of the card's figure (GET …/cards/{id}/figure, backend card_export.py), each
// saved as a file (GET …/figure/{file}), as the report's Export saves a document (report/ExportMenu): listed on each
// open, the icon turning while one is made, a toast when one fails. A file this machine cannot make (no browser for the
// card harness) stays in the menu, disabled, with the server's reason as its tip. A download writes nothing in the
// corpus folder, so the menu works while Settings' Read only is on.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Menu, type MenuItem } from '../components/Menu'
import { apiBase } from '../lib/browserKey'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { fail, save, type ExportFormat } from '../report/ExportMenu'

const base = (ws: string, card: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}/cards/${encodeURIComponent(card)}/figure`

export function CardExport({ ws, card }: { ws: string; card: string }) {
  const [files, setFiles] = useState<ExportFormat[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // listed again on each open: the card, and whether the harness can draw it, may have changed since
  const load = async (open: boolean) => {
    if (!open) return
    setFiles(null)
    try {
      const res = await fetch(base(ws, card))
      if (!res.ok) await fail(res)
      setFiles(((await res.json()) as { files: ExportFormat[] }).files)
    } catch (e) {
      setFiles([])
      bus.emit('toast', { text: `Could not list the figure's files. ${(e as Error).message}`, kind: 'error' })
    }
  }
  const run = async (f: ExportFormat) => {
    track('ui-click', { target: `cell:${card}`, detail: { action: 'export', file: f.id } })
    setBusy(f.name)
    try {
      const res = await fetch(`${base(ws, card)}/${encodeURIComponent(f.id)}`)
      if (!res.ok) await fail(res)
      save(await res.blob(), res.headers.get('x-export-name') || `${card}.${f.ext}`)
    } catch (e) {
      bus.emit('toast', { text: `Could not export ${f.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const items: MenuItem[] = (files ?? []).map((f) => ({
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
      className="bcell-export"
      onOpenChange={(o) => void load(o)}
      items={items.length ? items : [{ id: 'loading', heading: files ? 'No files' : 'Loading' }]}
      trigger={<Button variant="icon" size="sm" icon="download" title={busy ? `Exporting ${busy}` : 'Export'} aria-label="Export" busy={busy != null} />}
    />
  )
}
