// The bar's two menus. New makes another document of the report's kind, from a name: one the person owns, types into
// and places cards in, and which Write fills. The ⋯ beside a document of the person's own renames or deletes it.
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { Menu, Popover, type MenuItem } from '../components/Menu'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ReportType } from '../lib/types'

/** New and its sheet for the new document's name; `onMade` gets the new document. */
export function NewDocMenu({ ws, onMade }: { ws: string; onMade: (t: ReportType) => void }) {
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [name, setName] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!asking) return
    const id = window.requestAnimationFrame(() => nameField.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [asking])

  const make = async () => {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      const t = await docsApi.createDoc(ws, { kind: 'document', name: name.trim() })
      track('ui-click', { target: `report:${t.slug}`, detail: { action: 'doc-new' } })
      setAsking(false)
      setName('')
      onMade(t)
    } catch (e) {
      bus.emit('toast', { text: `Could not make the report. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button ref={trigger} icon="plus" className="wu-new" disabled={busy} data-doc-chip="+new" aria-haspopup="dialog" aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
        New
      </Button>
      <Popover anchor={trigger} open={asking} onClose={() => setAsking(false)} label="A new report" className="wu-doc-sheet" width={300}>
        <form
          className="wu-doc-form"
          onSubmit={(e) => {
            e.preventDefault()
            void make()
          }}
        >
          <label className="label" htmlFor="wu-doc-name">
            Name
          </label>
          <TextInput id="wu-doc-name" ref={nameField} value={name} onChange={setName} block placeholder="Team update" />
          <div className="wu-doc-actions">
            <Button size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" type="submit" busy={busy} disabled={!name.trim()}>
              Make
            </Button>
          </div>
        </form>
      </Popover>
    </>
  )
}

/** The ⋯ beside a document of the person's own: Rename and Delete, each confirmed in a sheet. */
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
              Delete {name}? Its drafts go with it.
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
