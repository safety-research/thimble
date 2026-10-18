// Message.tsx: one of Claude's messages in the chat, from its record: the text with its marks (cite, explain, spark),
// and the cards its turn saved as 0.9's step row of card chips. The verbs (v visualize · s squeeze · c claims) are in
// the bar above the composer (KeyBar), as the terminal has them in its one bar; v opens its proposals under the
// message, s the squeeze chips: the chips program (lean/panes/chips.js) the terminal draws under the same message.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from '@09/components/Chip'
import { MarkedText, prepare, type MarkHost } from '../lib/marks'
import { openMark, pressVerb } from '../lib/actions'
import { PaneView } from '../panes/PaneView'
import { parseObj, setState, threadsOfRow, useStore, type Row } from '../lib/store'
import { threadName } from './ChatPanel'

export const VIEW_VERBS = new Set(['map', 'trace', 'explore'])

export function Message({ row }: { row: Row }) {
  const rec = row.record!
  const focus = useStore((s) => s.focus)
  const threads = useStore((s) => s.threads)
  const p = useMemo(() => prepare(rec), [rec])
  const host: MarkHost = {
    marks: p.marks,
    focus: focus && focus.row === row.row ? focus.i : null,
    onOpen: (i) => openMark({ row: row.row, i }),
    threadOf: (i) => {
      const m = p.marks[i]
      const t = threads.find((x) => x.scope?.row === row.row && !x.scope?.object && x.scope?.mark && ((m.ref && x.scope.mark.ref === m.ref) || (m.gloss && x.scope.mark.gloss === m.gloss)))
      return t ? { id: t.id, open: () => setState({ thread: t.id }) } : null
    },
  }
  return (
    <>
      <div className="chat-msg chat-assistant lean-msg" data-row={row.row}>
        <div className="chat-text">
          <MarkedText md={p.md} host={host} />
        </div>
        <Chips row={row} />
        <Proposals row={row} />
        <Squeeze row={row} />
      </div>
    </>
  )
}

/** Under the answer: a chip per card its turn saved (it selects the card on the Canvas, a view opens its tab), and a
 * chip per side thread started from it (it opens the thread in the chat), as 0.9 draws what a turn made. */
function Chips({ row }: { row: Row }) {
  const objects = useStore((s) => s.objects)
  const threads = useStore((s) => s.threads)
  const refs = (row.record?.objects || []).map(parseObj).filter((x): x is { id: string; v: number | null } => !!x)
  const mine = threadsOfRow(threads, row.row, row.record?.objects || [])
  if (!refs.length && !mine.length) return null
  return (
    <div className="lean-chips-row">
      {refs.map((o) => {
        const info = objects.find((x) => x.id === o.id)
        const view = info && VIEW_VERBS.has(String(info.verb))
        return (
          <Chip
            key={o.id}
            kind="ref"
            tone="accent"
            icon={view ? 'view' : 'cell'}
            className="refchip refchip-card"
            title={info?.question || info?.title || o.id}
            onClick={() => {
              if (view) setState({ surface: 'files', filesView: `view:${o.id}`, card: null })
              else setState({ surface: 'canvas', selected: o.id, reveal: o.id, card: null })
            }}
          >
            {cut(o.id.replace(/^\d+-/, ''), 30)}
          </Chip>
        )
      })}
      {mine.map((t) => (
        <Chip key={t.id} kind="ref" tone="accent" icon="thread" face="sans" className="refchip lean-thread-chip" title={t.turns.find((x) => x.role === 'user')?.text || ''} onClick={() => setState({ thread: t.id })}>
          {cut(`main/${threadName(t)}`, 30)}
        </Chip>
      ))}
    </div>
  )
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A line that opens under a message comes into view in the chat. */
function useIntoView(open: boolean) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) requestAnimationFrame(() => el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [open])
  return el
}

/** v's line under a message: the proposals program (lean/panes/proposals.js), the same one the terminal draws under
 * it. A pick runs v on the message in the terminal; its keys are in the bar while it is open. */
function Proposals({ row }: { row: Row }) {
  const open = useStore((s) => s.propsOpen === row.row)
  const el = useIntoView(open)
  if (!open) return null
  return (
    <div className="lean-props" ref={el}>
      <PaneView
        name="proposals"
        args={{ row: row.row, verb: 'v' }}
        rows={3}
        focus
        onClose={() => setState({ propsOpen: null })}
        actions={{ pick: (e) => void pressVerb(row.row, 'v', String(e.choice || '')) }}
        onDrawn={() => el.current?.scrollIntoView({ block: 'nearest' })}
        className="lean-props-pane"
      />
    </div>
  )
}

/** The squeeze chips under a message: the chips program (lean/panes/chips.js), the same one the terminal draws under
 * it, on the message's record. Its keys are in the bar while it is open; a change goes to the terminal, which rewrites
 * the message in place, and the record then shows the new text here. */
function Squeeze({ row }: { row: Row }) {
  const open = useStore((s) => s.squeezeOpen === row.row)
  const el = useIntoView(open)
  if (!open) return null
  return (
    <div className="lean-squeeze" ref={el}>
      <PaneView name="chips" args={{ row: row.row }} rows={4} focus onClose={() => setState({ squeezeOpen: null })} onDrawn={() => el.current?.scrollIntoView({ block: 'nearest' })} className="lean-chips-pane" />
    </div>
  )
}
