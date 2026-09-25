// A written document's history in the Report tab: a sheet of its drafts, newest first (historyModel.ts historyRows over
// GET …/types/{slug}/versions), each with its number, time, author, length and what changed. A writer run is one draft,
// its earlier saves folded under it. A past draft or save shows read-only in place of the editor (PastDraft) with Back to
// current; Compare shows what changed between two saves (DraftDiff, diffModel.ts diffDocs). There is no restore.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { GlyphCites, RefChip } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { docsApi, isNotFound } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { AnyDoc, DocHistory, WriteupSection } from '../lib/types'
import { diffDocs, diffLine, foldSame, splitRefs, type DiffBlock, type DiffPart } from './diffModel'
import { currentRef, draftMeta, draftName, historyRows, previousOf, rowMeta, sameRef, type DraftRef, type HistoryRow, type HistoryView } from './historyModel'
import { figuresAfter, sectionsOf } from './model'
import { Prose } from './Prose'

/** The document's history, read while the sheet is open or a past draft is shown, and again when a new draft lands. */
function useHistory(ws: string, slug: string, generation: number | undefined, on: boolean) {
  const [history, setHistory] = useState<DocHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setHistory(null)
    setError(null)
  }, [ws, slug])
  useEffect(() => {
    if (!on) return
    let live = true
    docsApi
      .versions(ws, slug)
      .then((h) => {
        if (!live) return
        setHistory(h)
        setError(null)
      })
      .catch((e) => live && setError(isNotFound(e) ? 'No drafts yet' : (e as Error).message))
    return () => {
      live = false
    }
  }, [ws, slug, generation, on])
  return { history, error }
}

export interface HistoryMenuProps {
  ws: string
  slug: string
  /** the current draft's number, so the list is read again when a new one lands */
  generation?: number
  /** what History shows in place of the editor, or null for the current draft in the editor */
  view: HistoryView | null
  /** the view to show, with the rows it was picked from (for the band's names); null for the editor */
  onView: (view: HistoryView | null, rows: HistoryRow[]) => void
}

/** A save's text: generation `n`, or an earlier save of its run. */
export const readRef = (ws: string, slug: string, ref: DraftRef): Promise<AnyDoc> =>
  ref.rev != null ? docsApi.revision(ws, slug, ref.n, ref.rev) : docsApi.version(ws, slug, ref.n)

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** History in the type bar and its sheet of drafts. */
export function HistoryMenu({ ws, slug, generation, view, onView }: HistoryMenuProps) {
  const [open, setOpen] = useState(false)
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set())
  const trigger = useRef<HTMLButtonElement | null>(null)
  const { history, error } = useHistory(ws, slug, generation, open)
  const rows = historyRows(history)
  const now = currentRef(rows)
  const shownRef = view?.kind === 'draft' ? view.target : null
  const go = (next: HistoryView | null, action: string, detail: Record<string, unknown> = {}) => {
    setOpen(false)
    track('ui-click', { target: `report:${slug}`, detail: { action, ...detail } })
    onView(next, rows)
  }
  const pick = (ref: DraftRef, current: boolean) => go(current ? null : { kind: 'draft', target: ref }, 'history-open', { draft: ref.n, save: ref.rev, current })
  const compare = (from: DraftRef, to: DraftRef) => go({ kind: 'diff', from, to }, 'history-compare', { from: from.n, from_save: from.rev, to: to.n, to_save: to.rev })
  /** Compare with previous and with current, for one save */
  const actions = (ref: DraftRef, current: boolean, extra?: ReactNode) => {
    const prev = previousOf(rows, ref)
    return (
      <div className="wu-history-actions">
        {prev && (
          <button type="button" className="wu-history-act" onClick={() => compare(prev, ref)}>
            Compare with previous
          </button>
        )}
        {!current && now && (
          <button type="button" className="wu-history-act" onClick={() => compare(ref, now)}>
            Compare with current
          </button>
        )}
        {extra}
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`wu-export wu-history-btn${view != null ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((o) => !o)
          if (!open)
            track('ui-click', {
              target: `report:${slug}`,
              detail: { action: 'history' },
            })
        }}
      >
        History
      </button>
      <Popover anchor={trigger} open={open} onClose={() => setOpen(false)} align="end" label="History" className="wu-history" width={380}>
        {!history && !error && (
          <div className="wu-history-status">
            <Spinner size={12} label="Reading the history" />
          </div>
        )}
        {error && <div className="wu-history-status">{error}</div>}
        {rows.length > 0 && (
          <ol className="wu-history-list">
            {rows.map((r) => {
              const ref: DraftRef = { n: r.n, rev: null }
              const shown = view == null ? r.current : sameRef(shownRef, ref)
              const folded = !unfolded.has(r.n)
              const toggle =
                r.revisions.length > 0 ? (
                  <button
                    type="button"
                    className="wu-history-act wu-history-fold"
                    aria-expanded={!folded}
                    onClick={() =>
                      setUnfolded((u) => {
                        const next = new Set(u)
                        if (next.has(r.n)) next.delete(r.n)
                        else next.add(r.n)
                        return next
                      })
                    }
                  >
                    <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={12} />
                    {plural(r.revisions.length, 'earlier save', 'earlier saves')}
                  </button>
                ) : undefined
              return (
                <li key={r.n} className="wu-history-item">
                  <button
                    type="button"
                    className={`wu-history-row${shown ? ' shown' : ''}`}
                    disabled={!r.available}
                    title={r.available ? r.ts : 'This draft was not kept'}
                    onClick={() => r.available && pick(ref, r.current)}
                  >
                    <span className="wu-history-head">
                      <span className="wu-history-n">{r.label}</span>
                      {r.current && <span className="wu-history-tag">Current</span>}
                      {!r.current && shown && <span className="wu-history-tag">Shown</span>}
                    </span>
                    <span className="wu-history-meta">{rowMeta(r)}</span>
                    {r.asked && <span className="wu-history-asked">{`Asked: ${r.asked}`}</span>}
                    {r.changes.length > 0 && (
                      <ul className="wu-history-changes">
                        {r.changes.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </button>
                  {r.available ? actions(ref, r.current, toggle) : toggle && <div className="wu-history-actions">{toggle}</div>}
                  {!folded && (
                    <ol className="wu-history-revs">
                      {[...r.revisions].reverse().map((s) => {
                        const sref: DraftRef = { n: r.n, rev: s.i }
                        return (
                          <li key={s.i}>
                            <button
                              type="button"
                              className={`wu-history-rev${sameRef(shownRef, sref) ? ' shown' : ''}`}
                              disabled={!s.available}
                              title={s.available ? s.ts : 'This save was not kept'}
                              onClick={() => s.available && pick(sref, false)}
                            >
                              <span className="wu-history-n">{s.label}</span>
                              <span className="wu-history-meta">{[s.when, s.words].filter(Boolean).join(' · ')}</span>
                            </button>
                            {s.available && actions(sref, false)}
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </Popover>
    </>
  )
}

/** A card's ref from a figure's `cell`, which may be the bare id. */
const cardRef = (cell: string) => (cell.includes(':') ? cell : `card:${cell}`)

function PastSection({ ws, slug, sec, first }: { ws: string; slug: string; sec: WriteupSection; first: boolean }) {
  const figure = (f: { id: string; cell: string | null; caption: string }) => (
    <figure key={f.id} className="wu-past-fig">
      {f.cell && <RefChip ref={cardRef(f.cell)} workspace={ws} />}
      {f.caption && <figcaption>{f.caption}</figcaption>}
    </figure>
  )
  const lead = (sec.figures ?? []).filter((f) => f.lead)
  return (
    <section className="wu-past-sec">
      {sec.heading && (sec.level && sec.level >= 3 ? <h3>{sec.heading}</h3> : <h2 className={first ? 'first' : undefined}>{sec.heading}</h2>)}
      {lead.map(figure)}
      {sec.paragraphs.map((p) => {
        const sentences = p.sentences ?? []
        const listed = sentences.length > 0 && sentences.every((s) => s.bullet)
        return (
          <div key={p.id}>
            {listed ? (
              <ul className="wu-past-list">
                {sentences.map((s) => (
                  <li key={s.id}>
                    <Prose ws={ws} slug={slug} sentences={[s]} anchors={false} />
                  </li>
                ))}
              </ul>
            ) : (
              sentences.length > 0 && <Prose ws={ws} slug={slug} sentences={sentences} anchors={false} />
            )}
            {figuresAfter(sec, p.id).map(figure)}
          </div>
        )
      })}
      {figuresAfter(sec, null).map(figure)}
    </section>
  )
}

export interface PastDraftProps {
  ws: string
  slug: string
  target: DraftRef
  /** the history's rows, for the band's name and meta */
  rows: HistoryRow[]
  onClose: () => void
}

/** A band over a past draft or a diff: its name, a mono line, what changed, Open writer's chat, Back to current. */
function Band({ name, meta, changes, writer, onClose }: { name: string; meta: string; changes?: string[]; writer?: string | null; onClose: () => void }) {
  return (
    <div className="wu-past-band">
      <div className="wu-past-band-text">
        <span className="wu-past-name">{name}</span>
        <span className="wu-past-meta">{meta}</span>
        {changes && changes.length > 0 && (
          <ul className="wu-history-changes">
            {changes.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>
      {writer && (
        <Button variant="ghost" size="sm" onClick={() => bus.emit('openChat', { chatId: writer })}>
          Open writer's chat
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={onClose}>
        Back to current
      </Button>
    </div>
  )
}

/** One or more saves read by ref; `docs` null while any is being read. */
function useSaves(ws: string, slug: string, refs: DraftRef[]) {
  const key = refs.map((r) => `${r.n}.${r.rev ?? ''}`).join(' ')
  const [docs, setDocs] = useState<AnyDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const read = useCallback(async () => {
    setDocs(null)
    setError(null)
    try {
      setDocs(await Promise.all(refs.map((r) => readRef(ws, slug, r))))
    } catch (e) {
      setError(isNotFound(e) ? 'This draft was not kept' : (e as Error).message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the refs
  }, [ws, slug, key])
  useEffect(() => {
    void read()
  }, [read])
  return { docs, error }
}

function Loading({ docs, error, what }: { docs: unknown; error: string | null; what: string }) {
  return (
    <>
      {!docs && !error && (
        <div className="wu-status">
          <Spinner size={14} label={`Loading the ${what}`} />
        </div>
      )}
      {error && (
        <div className="wu-status wu-error">
          {`Could not load the ${what}`}
          <div className="wu-error-detail">{error}</div>
        </div>
      )}
    </>
  )
}

/** A past draft, or an earlier save of a run, read-only, under a band that names it and goes back to the current one. */
export function PastDraft({ ws, slug, target, rows, onClose }: PastDraftProps) {
  const { docs, error } = useSaves(ws, slug, [target])
  const doc = docs?.[0] ?? null
  const row = rows.find((r) => r.n === target.n) ?? null
  const sections = doc ? sectionsOf(doc) : []
  const total = rows.length
  const name = `${draftName(rows, target)}${target.rev == null && total ? ` of ${total}` : ''}`
  return (
    <div className="wu-past" data-draft={target.n} data-save={target.rev ?? undefined}>
      <Band
        name={name}
        meta={[draftMeta(rows, target), 'read-only'].filter(Boolean).join(' · ')}
        changes={target.rev == null ? row?.changes : undefined}
        writer={row?.writer}
        onClose={onClose}
      />
      <div className="wu-past-scroll">
        <Loading docs={doc} error={error} what="draft" />
        {doc && (
          <article className="wu-past-page">
            {doc.title && <h1>{doc.title}</h1>}
            {sections.map((sec, i) => (
              <PastSection key={sec.id} ws={ws} slug={slug} sec={sec} first={i === 0 && !doc.title} />
            ))}
          </article>
        )}
      </div>
    </div>
  )
}

/** A part's text with its citations as the report draws them (Prose, under GlyphCites): a bare one its target's glyph
 * alone with its name in the hover, so a long name (a call's command) is never cut off at the column's edge. */
function partText(ws: string, text: string): ReactNode[] {
  return splitRefs(text).map((p, i) =>
    'text' in p ? <Fragment key={i}>{p.text}</Fragment> : <RefChip key={i} ref={p.ref} value={p.value ?? undefined} workspace={ws} cite />,
  )
}

function Parts({ ws, parts }: { ws: string; parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.op === 'ins' ? (
          <ins key={i} className="wu-diff-ins">
            {partText(ws, p.text)}
          </ins>
        ) : p.op === 'del' ? (
          <del key={i} className="wu-diff-del">
            {partText(ws, p.text)}
          </del>
        ) : (
          <Fragment key={i}>{partText(ws, p.text)}</Fragment>
        ),
      )}
    </>
  )
}

const OP_WORD = { ins: 'Added', del: 'Removed', mod: 'Changed', same: '' } as const

function DiffBlockView({ ws, b }: { ws: string; b: DiffBlock }) {
  const cls = b.op === 'same' ? 'wu-diff-block' : `wu-diff-block wu-diff-b-${b.op}`
  const body = <Parts ws={ws} parts={b.parts} />
  const title = OP_WORD[b.op] || undefined
  switch (b.kind) {
    case 'title':
      return <h1 className={cls} title={title}>{body}</h1>
    case 'heading':
      return <h2 className={cls} title={title}>{body}</h2>
    case 'subheading':
      return <h3 className={cls} title={title}>{body}</h3>
    case 'item':
      return <li className={cls} title={title}>{body}</li>
    case 'figure':
      return (
        <figure className={`wu-past-fig ${cls}`} title={title}>
          {b.cell && <RefChip ref={cardRef(b.cell)} workspace={ws} />}
          <figcaption>{body}</figcaption>
        </figure>
      )
    default:
      return <p className={`wu-prose ${cls}`} title={title}>{body}</p>
  }
}

/** Blocks in reading order, consecutive list items in one list. */
function DiffBlocks({ ws, blocks }: { ws: string; blocks: DiffBlock[] }) {
  const out: ReactNode[] = []
  for (let k = 0; k < blocks.length; ) {
    if (blocks[k].kind === 'item') {
      const start = k
      while (k < blocks.length && blocks[k].kind === 'item') k++
      out.push(
        <ul key={start} className="wu-past-list">
          {blocks.slice(start, k).map((b, i) => (
            <DiffBlockView key={i} ws={ws} b={b} />
          ))}
        </ul>,
      )
    } else {
      out.push(<DiffBlockView key={k} ws={ws} b={blocks[k]} />)
      k++
    }
  }
  return <>{out}</>
}

export interface DraftDiffProps {
  ws: string
  slug: string
  from: DraftRef
  to: DraftRef
  rows: HistoryRow[]
  onClose: () => void
}

/** What changed from one save to another, read-only: added blocks and words in the positive ink on its soft tint,
 * removed ones struck through in the negative, a changed block marked at its edge, runs of unchanged blocks folded. */
export function DraftDiff({ ws, slug, from, to, rows, onClose }: DraftDiffProps) {
  const { docs, error } = useSaves(ws, slug, [from, to])
  const diff = useMemo(() => {
    if (!docs) return null
    const [a, b] = docs
    return diffDocs({ title: a.title, sections: sectionsOf(a) }, { title: b.title, sections: sectionsOf(b) })
  }, [docs])
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setOpened(new Set()), [diff])
  const toName = rows.find((r) => r.n === to.n)?.current && to.rev == null ? `Current (${draftName(rows, to)})` : draftName(rows, to)
  const items = diff ? foldSame(diff.blocks) : []
  return (
    <div className="wu-past wu-diff" data-from={`${from.n}.${from.rev ?? ''}`} data-to={`${to.n}.${to.rev ?? ''}`}>
      <Band name={`${draftName(rows, from)} → ${toName}`} meta={[diff ? diffLine(diff) : '', 'read-only'].filter(Boolean).join(' · ')} onClose={onClose} />
      <div className="wu-past-scroll">
        <Loading docs={docs} error={error} what="drafts" />
        {diff && (
          <GlyphCites.Provider value={true}>
            <article className="wu-past-page">
              <div className="wu-diff-legend" aria-hidden>
                <ins className="wu-diff-ins">added</ins>
                <del className="wu-diff-del">removed</del>
              </div>
              {items.map((it, k) =>
                'fold' in it && !opened.has(k) ? (
                  <button key={k} type="button" className="wu-diff-fold" onClick={() => setOpened((o) => new Set(o).add(k))}>
                    {plural(it.fold.length, 'unchanged block', 'unchanged blocks')}
                  </button>
                ) : (
                  <DiffBlocks key={k} ws={ws} blocks={'fold' in it ? it.fold : it.blocks} />
                ),
              )}
            </article>
          </GlyphCites.Provider>
        )}
      </div>
    </div>
  )
}
