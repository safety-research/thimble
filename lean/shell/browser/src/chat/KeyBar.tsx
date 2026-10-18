// KeyBar.tsx: the browser's one bar, above the composer, as the terminal's thimble line is above its prompt. At its
// left, what the keys do now, in words: the keys of the pane on top of the focus stack (the chips, Claims, a card's
// detail), as its program names them; the bottom panel's while a cite or explain card is open; else the verbs of the
// message the keys act on (a lit verb with its note), `] cite & explain` when it has marks, `1 open detail` when a card
// is picked on the canvas. At its right, the session's counts that are not zero. Each verb is a press too.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { allMarks, pressVerb, rowVerbs, stepMark } from '../lib/actions'
import { prepare } from '../lib/marks'
import { setState, useStore } from '../lib/store'

type Seg = { key: string; words: string; lit?: boolean; verb?: string; act?: () => void }

/** Keys as the bar says them, `r replay · esc close`, cut into each key and its words. */
export function segments(keys: string): Seg[] {
  return keys
    .split(' · ')
    .filter(Boolean)
    .map((seg) => {
      const lit = /^([a-z]) ● (.*)$/.exec(seg)
      if (lit) return { key: lit[1], words: `● ${lit[2]}`, lit: true }
      const t = seg.split(' ')
      if (t[0].length > 3 && /^[a-z]+$/.test(t[0])) return { key: '', words: seg }
      let n = 1
      while (n < t.length && /^[^\p{L}\p{N}]+$/u.test(t[n])) n++
      return { key: t.slice(0, n).join(' '), words: t.slice(n).join(' ') }
    })
}

const pct = (part: number) => (!(part > 0) ? '0%' : part >= 1 ? '100%' : part * 100 < 1 ? `${(part * 100).toFixed(1)}%` : `${Math.min(99, Math.round(part * 100))}%`)

export function KeyBar() {
  const keybar = useStore((s) => s.keybar)
  const tray = useStore((s) => s.tray)
  const trayAsk = useStore((s) => s.trayAsk)
  const rows = useStore((s) => s.rows)
  const verbs = useStore((s) => s.verbs)
  const focus = useStore((s) => s.focus)
  const selected = useStore((s) => s.selected)
  const card = useStore((s) => s.card)
  const objects = useStore((s) => s.objects)
  const threads = useStore((s) => s.threads)
  const info = useStore((s) => s.info)
  const version = useStore((s) => s.version)
  const [claims, setClaims] = useState(0)
  useEffect(() => {
    void api('claims').then((r) => !r.error && setClaims((r.store?.claims || []).length))
  }, [version])
  const marks = useMemo(() => allMarks(rows), [rows])

  // the message the keys act on: the one a mark was opened in, else the latest answer
  const acting = focus?.row || [...rows].reverse().find((r) => r.kind === 'assistant' && r.record)?.row || null
  const rec = acting ? rows.find((r) => r.row === acting)?.record : null
  let left: Seg[] = []
  if (keybar) {
    // what the pane says of itself now (k.status: `s ● 6 of 24 lines`, a problem), then its keys
    left = [...(keybar.status ? segments(keybar.status).map((x) => ({ ...x, lit: true })) : []), ...segments(keybar.keys)]
  } else if (tray.length) {
    // the bottom panel's keys, each a press too (the panel itself names none: they are here, once)
    const acts: Record<string, () => void> = {
      '1': () => setState({ trayAsk: true }),
      '0': () => setState((s) => (s.trayAsk ? { trayAsk: false } : { tray: s.tray.slice(0, -1), focus: s.tray.length > 1 ? s.focus : null })),
      ']': () => stepMark(marks, 1),
    }
    left = segments(trayAsk ? 'type to ask · ↵ asks this thread · 0 back' : `1 ask · ${tray.length > 1 ? '0 back' : '0 close'} · ] next`).map((g) => (acts[g.key] ? { ...g, act: acts[g.key] } : g))
  } else if (!card && rec) {
    left = rowVerbs(verbs).map((v) => {
      const st = rec.verbs?.[v.key] || rec.verbs?.[v.send] || {}
      const lit = st.lit === true && !!st.note
      return { key: v.key, words: lit ? `● ${st.note}` : v.name, lit, verb: v.key, act: () => void pressVerb(acting!, v.key) }
    })
    if (prepare(rec).marks.length) left.push({ key: ']', words: 'cite & explain', act: () => stepMark(marks, 1) })
    if (selected) left.push({ key: '1', words: 'open detail', act: () => setState({ card: { id: selected, v: null, region: null } }) })
  }
  const cites = useMemo(() => rows.reduce((n, r) => n + (r.record ? prepare(r.record).marks.filter((m) => m.kind === 'cite').length : 0), 0), [rows])
  // the share of the folder's rows Claude read, as the terminal's line counts it
  const cov = typeof info?.coverage?.share === 'number' ? info.coverage.share : 0
  const counts = [
    [objects.length, objects.length === 1 ? '1 card' : `${objects.length} cards`],
    [threads.length, threads.length === 1 ? '1 thread' : `${threads.length} threads`],
    [cites, cites === 1 ? '1 cite' : `${cites} cites`],
    [claims, claims === 1 ? '1 claim' : `${claims} claims`],
    [cov, `coverage ${pct(cov)}`],
  ].filter(([n]) => (n as number) > 0).map(([, w]) => w as string)
  if (!left.length && !counts.length) return null
  return (
    <div className="lean-keybar" role="status" aria-label="What the keys do now">
      <span className="lean-keybar-left">
        <span className="lean-keybar-name">thimble</span>
        {left.map((g, i) => {
          const body = (
            <>
              {g.key && <b>{g.key}</b>}
              {g.words && <span>{g.key ? ' ' : ''}{g.words}</span>}
            </>
          )
          return (
            <span key={i} className="lean-keybar-seg">
              {i > 0 && <span className="lean-keybar-sep">·</span>}
              {g.act ? (
                <button type="button" className={`lean-keybar-key${g.lit ? ' is-lit' : ''}${g.verb ? ` lean-verb-${g.verb}` : ''}`} onClick={g.act}>
                  {body}
                </button>
              ) : (
                <span className={`lean-keybar-key${g.lit ? ' is-lit' : ''}`}>{body}</span>
              )}
            </span>
          )
        })}
      </span>
      {counts.length > 0 && <span className="lean-keybar-counts">{counts.join(' · ')}</span>}
    </div>
  )
}
