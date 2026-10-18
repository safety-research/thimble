// ReportPane.tsx: 0.9's Report on lean's objects. A document is an object of kind "document" (markdown with its
// citations, in its `text` or its data's `markdown`); the bar lists them as 0.9 lists its documents, the sidebar lists
// the cards by group as 0.9's does, and the page shows the document with its citations live. With no document yet it
// is 0.9's empty report.
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@09/components/Icon'
import { Segmented } from '@09/components/Button'
import { Spinner } from '@09/components/Spinner'
import { objectOf } from '../lib/api'
import { CitedText } from '../lib/marks'
import { pushCite } from '../lib/actions'
import { cardGroups, isDocument, setState, useStore } from '../lib/store'

export function ReportPane() {
  const objects = useStore((s) => s.objects)
  const rows = useStore((s) => s.rows)
  const docs = useMemo(() => objects.filter(isDocument), [objects])
  const groups = useMemo(() => cardGroups(rows, objects), [rows, objects])
  const [slug, setSlug] = useState<string>('report')
  const [find, setFind] = useState('')
  const cur = docs.find((d) => d.id === slug) ?? docs[0] ?? null
  const options = docs.length ? docs.map((d) => ({ value: d.id, label: d.title || d.id, icon: 'doc' as const })) : [{ value: 'report', label: 'Report', icon: 'doc' as const }]
  return (
    <div className="wu-root" data-panel="report">
      <div className="wu-bar">
        <Segmented className="wu-types" label="Documents" size="lg" value={cur ? cur.id : 'report'} onChange={setSlug} options={options} />
        <span className="wu-bar-spacer" />
      </div>
      <div className="wu-body">
        <div className="wu-report wu-arranged">
          <aside className="wu-side" aria-label="Cards">
            <div className="wu-side-cards">
              <div className="wu-side-top">
                <label className="wu-search">
                  <Icon name="search" size={13} />
                  <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search cards" aria-label="Search cards" />
                </label>
              </div>
              <div className="wu-side-list">
                {groups.map((g) => {
                  const cards = g.cards.filter((c) => {
                    const o = objects.find((x) => x.id === c.id)
                    return !find || `${o?.title} ${o?.question}`.toLowerCase().includes(find.toLowerCase())
                  })
                  if (!cards.length) return null
                  return (
                    <section key={g.id} className="wu-sec">
                      <button type="button" className="wu-sec-head" aria-expanded="true">
                        <Icon name="chevron-right" size={12} className="wu-sec-caret" style={{ transform: 'rotate(90deg)' }} />
                        <span className="wu-sec-name">{g.title}</span>
                        <span className="wu-count">{cards.length}</span>
                      </button>
                      {cards.map((c) => {
                        const o = objects.find((x) => x.id === c.id)
                        return (
                          <button key={c.id} type="button" className="wu-card-row" onClick={() => setState({ surface: 'canvas', selected: c.id, reveal: c.id, card: null })}>
                            <Icon name="graph" size={13} className="wu-card-ico" />
                            <span className="wu-card-q">{o?.question || o?.title || c.id}</span>
                          </button>
                        )
                      })}
                    </section>
                  )
                })}
              </div>
            </div>
          </aside>
          <div className="wu-arranged-view">{cur ? <Doc id={cur.id} /> : <Empty />}</div>
        </div>
      </div>
    </div>
  )
}

function Doc({ id }: { id: string }) {
  const [o, setO] = useState<any>(null)
  const updated = useStore((s) => s.objects.find((x) => x.id === id)?.updated)
  useEffect(() => {
    let alive = true
    void objectOf(id).then((r) => alive && setO(r.object || { error: r.error }))
    return () => {
      alive = false
    }
  }, [id, updated])
  if (!o)
    return (
      <div className="wu-status">
        <Spinner size={14} label="Loading the document" />
      </div>
    )
  const md = String(o.data?.markdown ?? o.text ?? '')
  return (
    <div className="lean-doc">
      <div className="lean-doc-col">
        {o.title && !/^#\s/.test(md) && <h1>{o.title}</h1>}
        <div className="chat-text lean-doc-text">
          <CitedText text={md} onCite={(ref, label) => pushCite({ kind: 'cite', ref, label })} />
        </div>
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div className="lean-doc lean-doc-empty">
      <div className="lean-doc-col">
        <p className="lean-doc-none">Nothing is written yet.</p>
        <p className="lean-doc-hint">Ask Claude in the terminal session for a report. It is saved as a document with its citations, and shows here.</p>
      </div>
    </div>
  )
}
