// The type bar's two menus. + New makes a document: a page, a preset (prompts/types on the server), or a custom type
// from a name and a brief. The ⋯ beside a workspace's own type renames or deletes it with its document. The chat makes
// the same documents through start_writing's `type` (backend write_session).
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextArea, TextInput } from '../components/Field'
import { Menu, Popover, type MenuItem } from '../components/Menu'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { DocPreset, ReportType } from '../lib/types'
import { newDocItems } from './model'

/** + New and its sheet for a document of the analyst's own; `onMade` gets the new type. */
export function NewDocMenu({ ws, onMade }: { ws: string; onMade: (t: ReportType) => void }) {
  const [presets, setPresets] = useState<DocPreset[]>([])
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    let live = true
    docsApi
      .presets(ws)
      .then((p) => live && setPresets(p))
      .catch(() => {
        /* + New still offers a page and a custom document */
      })
    return () => {
      live = false
    }
  }, [ws])
  useEffect(() => {
    if (!asking) return
    const id = window.requestAnimationFrame(() => nameField.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [asking])

  const make = async (kind: string, body: { name?: string; brief?: string } = {}) => {
    if (busy) return
    setBusy(true)
    try {
      const t = await docsApi.createDoc(ws, { kind, ...body })
      track('ui-click', { target: `report:${t.slug}`, detail: { action: 'doc-new', kind } })
      setAsking(false)
      setName('')
      setBrief('')
      onMade(t)
    } catch (e) {
      bus.emit('toast', { text: `Could not make the document. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const items: MenuItem[] = newDocItems(presets).map((it) => ({
    id: it.kind,
    label: it.custom ? `${it.label}…` : it.label,
    onSelect: () => (it.custom ? setAsking(true) : void make(it.kind)),
  }))
  const ready = !!name.trim() && !!brief.trim()
  return (
    <>
      <Menu label="New document" trigger={<button type="button" ref={trigger} className="wu-new" disabled={busy} data-doc-chip="+new">+ New</button>} items={items} />
      <Popover anchor={trigger} open={asking} onClose={() => setAsking(false)} label="A document of your own" className="wu-doc-sheet" width={320}>
        <form
          className="wu-doc-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) void make('document', { name: name.trim(), brief: brief.trim() })
          }}
        >
          <label className="label" htmlFor="wu-doc-name">
            Name
          </label>
          <TextInput id="wu-doc-name" ref={nameField} value={name} onChange={setName} block />
          <label className="label" htmlFor="wu-doc-brief">
            What it is for
          </label>
          <TextArea id="wu-doc-brief" value={brief} onChange={setBrief} block rows={3} />
          <div className="wu-doc-actions">
            <Button size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" type="submit" busy={busy} disabled={!ready}>
              Make
            </Button>
          </div>
        </form>
      </Popover>
    </>
  )
}

/** The ⋯ beside a type of the workspace's own: Rename and Delete, each confirmed in a sheet. */
export function TypeActions({ ws, slug, name, onDeleted }: { ws: string; slug: string; name: string; onDeleted: () => void }) {
  const [sheet, setSheet] = useState<'rename' | 'delete' | null>(null)
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (sheet !== 'rename') return
    setValue(name)
    const id = window.requestAnimationFrame(() => field.current?.select())
    return () => window.cancelAnimationFrame(id)
  }, [sheet, name])
  const run = async (what: 'rename' | 'delete') => {
    if (busy) return
    setBusy(true)
    try {
      if (what === 'rename') await docsApi.renameType(ws, slug, value.trim())
      else await docsApi.deleteType(ws, slug)
      track('ui-click', { target: `report:${slug}`, detail: { action: `doc-${what}` } })
      setSheet(null)
      if (what === 'delete') onDeleted()
    } catch (e) {
      bus.emit('toast', { text: `Could not ${what} ${name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const items: MenuItem[] = [
    { id: 'rename', label: 'Rename…', icon: 'edit', onSelect: () => setSheet('rename') },
    { id: 'delete', label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setSheet('delete') },
  ]
  return (
    <>
      <Menu label={`${name} actions`} trigger={<Button ref={trigger} variant="icon" size="sm" icon="more-horizontal" title={`${name} actions`} aria-label={`${name} actions`} className="wu-type-more" />} items={items} />
      <Popover anchor={trigger} open={sheet != null} onClose={() => setSheet(null)} label={sheet === 'delete' ? `Delete ${name}` : `Rename ${name}`} className="wu-doc-sheet" width={300}>
        {sheet === 'rename' ? (
          <form
            className="wu-doc-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value.trim() && value.trim() !== name) void run('rename')
            }}
          >
            <label className="label" htmlFor="wu-doc-rename">
              Name
            </label>
            <TextInput id="wu-doc-rename" ref={field} value={value} onChange={setValue} block />
            <div className="wu-doc-actions">
              <Button size="sm" onClick={() => setSheet(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" type="submit" busy={busy} disabled={!value.trim() || value.trim() === name}>
                Rename
              </Button>
            </div>
          </form>
        ) : (
          <div className="wu-doc-form">
            <p className="wu-doc-warn">
              Delete {name} and its document? The checks' comments on it go with it.
            </p>
            <div className="wu-doc-actions">
              <Button size="sm" onClick={() => setSheet(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" className="wu-doc-delete" busy={busy} onClick={() => void run('delete')}>
                Delete
              </Button>
            </div>
          </div>
        )}
      </Popover>
    </>
  )
}
