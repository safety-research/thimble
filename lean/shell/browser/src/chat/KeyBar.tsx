// KeyBar.tsx: the browser's one bar, across the foot of the page under both columns: it is the page's, not the chat's,
// as the terminal's thimble line is above its prompt. At its left, what the keys do now, in words: the keys of the pane
// on top of the focus stack (the tray, v's line, the chips, Claims, a card's detail), as its program names them; else
// the verbs of the message the keys act on (a lit verb with its note), `] cite & explain` when it has marks, `1 open
// detail` when a card is picked on the canvas. At its right, the session's counts that are not zero. Each verb is a
// press too. It is always one line: with less room it drops the counts (coverage last), then says each key by its first
// word, then drops its label (panes/host.js fitBar, the terminal's own rule).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { paneModules } from '../panes/lib'
import { allMarks, pressVerb, rowVerbs, stepMark } from '../lib/actions'
import { prepare } from '../lib/marks'
import { setState, useStore } from '../lib/store'

type Seg = { key: string; words: string; short?: string; lit?: boolean; verb?: string; act?: () => void }

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
  } else if (!card && rec) {
    left = rowVerbs(verbs).map((v) => {
      const st = rec.verbs?.[v.key] || rec.verbs?.[v.send] || {}
      const lit = st.lit === true && !!st.note
      return { key: v.key, words: lit ? `● ${st.note}` : v.name, short: lit ? `● ${v.name}` : undefined, lit, verb: v.key, act: () => void pressVerb(acting!, v.key) }
    })
    if (prepare(rec).marks.length) left.push({ key: ']', words: 'cite & explain', act: () => stepMark(marks, 1) })
    if (selected) left.push({ key: '1', words: 'open detail', act: () => setState({ card: { id: selected, v: null, region: null } }) })
  }
  const cites = useMemo(() => rows.reduce((n, r) => n + (r.record ? prepare(r.record).marks.filter((m) => m.kind === 'cite').length : 0), 0), [rows])
  // the share of the folder's rows Claude read, as the terminal's line counts it
  const cov = typeof info?.coverage?.share === 'number' ? info.coverage.share : 0
  const counts = ([
    ['cards', objects.length, objects.length === 1 ? '1 card' : `${objects.length} cards`],
    ['threads', threads.length, threads.length === 1 ? '1 thread' : `${threads.length} threads`],
    ['cites', cites, cites === 1 ? '1 cite' : `${cites} cites`],
    ['claims', claims, claims === 1 ? '1 claim' : `${claims} claims`],
    ['cov', cov, `coverage ${pct(cov)}`],
  ] as [string, number, string][]).filter(([, n]) => n > 0).map(([id, , text]) => ({ id, text }))
  const fitted = useFit({ label: 'thimble', left, counts })
  if (!left.length && !counts.length) return null
  return (
    <div className="lean-keybar lean-keybar-global" role="status" aria-label="What the keys do now" ref={fitted.ref}>
      <span className="lean-keybar-left">
        {fitted.bar.label && <span className="lean-keybar-name">{fitted.bar.label}</span>}
        {(fitted.bar.left as Seg[]).map((g, i) => {
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
      {fitted.bar.counts.length > 0 && <span className="lean-keybar-counts">{fitted.bar.counts.map((c: { text: string }) => c.text).join(' · ')}</span>}
    </div>
  )
}

type Bar = { label: string; left: Seg[]; counts: { id: string; text: string }[] }

/** The bar as it fits the page's width: the shared ladder (panes/host.js), measured in the bar's own font. */
function useFit(bar: Bar): { bar: Bar & { cut?: boolean }; ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [host, setHost] = useState<any>(null)
  useEffect(() => {
    void paneModules().then((m) => setHost(m.host), () => setHost(null))
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setWidth(el.clientWidth)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!host])
  const measure = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    const el = ref.current
    if (ctx && el) ctx.font = getComputedStyle(el).font
    // the keys are a little heavier than the words: 4% to spare
    return (s: string) => (ctx ? ctx.measureText(s).width * 1.04 : s.length * 7.4)
  }, [width])
  if (!host || !width) return { bar, ref }
  // the room inside the bar's padding
  const room = width - 28
  return { bar: host.fitBar(bar, room, measure), ref }
}
