// Tray.tsx: the bottom panel. A cite or explain mark opens its card here: a cite card shows what the value rests on
// (the rows behind it, read through the kernel with `lean resolve`: a table of rows, a quote, or a code hunk); an
// explain card shows a few plain words, a small drawing when the observer wrote one, and what it rests on. A
// citation inside a card opens over it, and 0 goes back. 1 asks: the question starts a side thread about the mark,
// which the chat column then shows; main does not see it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@09/components/Button'
import { Spinner } from '@09/components/Spinner'
import { fmt, resolveRef } from '../lib/api'
import { CitedText, isRef, prepare, Spark, type Prepared } from '../lib/marks'
import { ask, pushCite } from '../lib/actions'
import { columnsIn, drawingOf, svgOf } from '../lib/draw'
import { wordsOf, type Words } from '../lib/records'
import { getState, setState, useStore, type TrayEntry } from '../lib/store'

function markOf(entry: TrayEntry, rows: ReturnType<typeof getState>['rows']): Prepared | null {
  if ('row' in entry) {
    const rec = rows.find((r) => r.row === entry.row)?.record
    return rec ? prepare(rec).marks[entry.i] ?? null : null
  }
  return { kind: entry.kind, ref: entry.ref, label: entry.label, values: entry.values ?? null }
}

export function Tray() {
  const tray = useStore((s) => s.tray)
  const rows = useStore((s) => s.rows)
  const asking = useStore((s) => s.trayAsk)
  const top = tray[tray.length - 1]
  const m = top ? markOf(top, rows) : null
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (asking) input.current?.focus()
  }, [asking, top])
  useEffect(() => setQ(''), [top])
  if (!top || !m) return null
  const kind = m.kind === 'gloss' ? 'explain' : m.kind === 'spark' ? 'series' : 'cite'
  const close = () => setState({ tray: [], trayAsk: false, focus: null })
  const backOne = () => setState((s) => ({ tray: s.tray.slice(0, -1), trayAsk: false, focus: s.tray.length > 1 ? s.focus : null }))
  const send = async () => {
    const text = q.trim()
    if (!text) return
    const row = 'row' in top ? top.row : getState().focus?.row
    const mark = { kind: m.kind === 'gloss' ? 'gloss' : m.kind, ...(m.ref ? { ref: m.ref } : {}), ...(m.gloss ? { gloss: m.gloss } : {}), label: m.label, ...(m.kind === 'gloss' ? { term: m.label } : {}) }
    setQ('')
    if (await ask(text, { ...(row ? { row } : {}), mark })) {
      setState({ trayAsk: false, pendingThread: { row: row || '', ref: m.ref || m.gloss || m.label, at: Date.now() } })
    }
  }
  return (
    <section className={`lean-tray is-${kind}`} aria-label={`${kind} card`}>
      {tray.length > 1 && (
        <div className="lean-tray-stack">
          {tray.slice(0, -1).map((e, i) => {
            const x = markOf(e, rows)
            return (
              <button key={i} type="button" className="lean-tray-crumb" onClick={() => setState((s) => ({ tray: s.tray.slice(0, i + 1) }))}>
                {x?.kind === 'gloss' ? 'explain' : 'cite'} · {x?.label}
              </button>
            )
          })}
        </div>
      )}
      <header className="lean-tray-head">
        <span className={`lean-tray-kind lean-tray-kind-${kind}`}>{kind}</span>
        <span className="lean-tray-title">
          {m.kind === 'spark' && m.values?.length ? <Spark values={m.values} /> : <span className={m.kind === 'gloss' ? 'lean-mark lean-mark-explain' : 'lean-tray-cite'}>{m.label}</span>}
        </span>
        {m.ref && m.kind !== 'gloss' && <span className="lean-tray-ref">{m.ref}</span>}
        <span className="lean-tray-keys">
          <button type="button" className="lean-key" onClick={() => setState({ trayAsk: true })}>
            <kbd>1</kbd> ask
          </button>
          <span className="lean-verb-sep">·</span>
          <button type="button" className="lean-key" onClick={backOne}>
            <kbd>0</kbd> {tray.length > 1 ? 'back' : 'close'}
          </button>
        </span>
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" className="lean-tray-x" onClick={close} />
      </header>
      <div className="lean-tray-body">{m.kind === 'gloss' ? <ExplainBody m={m} /> : <SourceBody m={m} />}</div>
      {asking && (
        <form
          className="lean-tray-ask"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <span className="lean-tray-ask-about">about {m.label}</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask about ${m.label}… (a side thread; main does not see it)`} onKeyDown={(e) => e.key === 'Escape' && setState({ trayAsk: false })} />
          <Button variant={q.trim() ? 'primary' : 'secondary'} size="sm" icon="arrow-up" type="submit" title="Ask" aria-label="Ask" className="composer-send" disabled={!q.trim()} />
        </form>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- a cite card

interface Chain {
  line: string
  notes: string[]
  records: { ref: string; text: string }[]
  count?: number
  file: string
  error?: boolean
}

function chainOf(r: any, ref: string): Chain {
  if (!r) return { line: '', notes: [], records: [], file: '' }
  if (r.error) return { line: '', notes: [String(r.error)], records: [], file: '', error: true }
  const steps: string[] = []
  for (const c of r.chain || []) {
    if (c.step === 'query') steps.push(`${c.id}${c.about ? ' · ' + c.about : ''}`)
    else if (c.step === 'object' && !steps.length && c.at == null) steps.push(`${c.title || c.id}`)
  }
  const files = [...new Set((r.rows || []).map((x: string) => String(x).split('#')[0]))] as string[]
  const where = files.length === 1 ? files[0] : files.length ? `${files.length} files` : ''
  steps.push(r.count != null ? `${fmt(r.count)} source row${r.count === 1 ? '' : 's'}${where ? ' in ' + where : ''}` : where ? `all of ${where}` : 'no source rows')
  const notes = [...(r.notes || [])]
  return { line: steps.join(' ← '), notes, records: r.records || [], count: r.count, file: files[0] || String(ref).split('#')[0] }
}

const CODE = /\.(py|js|mjs|ts|tsx|rb|go|rs|java|c|h|cpp|sh|toml|ya?ml|cfg|ini)$/

function SourceBody({ m }: { m: Prepared }) {
  const [r, setR] = useState<any>(null)
  const [words, setWords] = useState<Words[] | null>(null)
  useEffect(() => {
    let alive = true
    setR(null)
    setWords(null)
    if (m.ref)
      void resolveRef(m.ref, 8).then(async (x) => {
        if (!alive) return
        setR(x)
        const w = await wordsOf(x.records || [])
        if (alive) setWords(w)
      })
    return () => {
      alive = false
    }
  }, [m.ref])
  if (!m.ref) return <p className="lean-tray-note">This mark names no ref, so there are no rows to show.</p>
  if (!r)
    return (
      <div className="lean-tray-wait">
        <Spinner size={12} label="reading" /> reading the rows behind it…
      </div>
    )
  const c = chainOf(r, m.ref)
  if (c.error) return <p className="lean-tray-problem">{c.notes[0]} · <span className="lean-tray-ref">{m.ref}</span></p>
  const recs = c.records
  const list = words ?? recs.map((x) => ({ ref: x.ref, words: x.text, meta: '' }))
  const quote = /^\s*["“]/.test(m.label) && recs.length === 1
  const said = m.label.replace(/^["“\s]+|["”\s]+$/g, '').replace(/…/g, '')
  const open = (ref: string) => setState({ surface: 'files', filesView: 'browser', file: ref, tray: [], focus: null })
  return (
    <>
      {m.kind === 'spark' && m.values?.length ? <SeriesBars values={m.values} /> : null}
      <p className="lean-tray-chain">← {c.line}</p>
      {c.notes.slice(0, 2).map((n, i) => (
        <p key={i} className="lean-tray-note">
          {n}
        </p>
      ))}
      {quote ? (
        <blockquote className="lean-tray-quote">
          <Highlight text={list[0].words} words={said} />
          <span className="lean-tray-quote-meta">
            {list[0].meta}
            <button type="button" className="lean-tray-rowref" onClick={() => open(recs[0].ref)}>
              {recs[0].ref}
            </button>
          </span>
        </blockquote>
      ) : CODE.test(c.file) && recs.length ? (
        <div className="lean-tray-code">
          <div className="lean-tray-code-head">{c.file}</div>
          {recs.map((x, i) => {
            const n = /#L(\d+)/.exec(x.ref)
            return (
              <div key={x.ref} className={`lean-tray-code-row${i === 0 ? ' is-hot' : ''}`}>
                <span className="lean-tray-code-no">{n ? n[1] : ''}</span>
                <span>{x.text}</span>
              </div>
            )
          })}
        </div>
      ) : recs.length ? (
        <table className="lean-tray-rows">
          <tbody>
            {list.map((x) => (
              <tr key={x.ref}>
                <td className="lean-tray-rowref-cell">
                  <button type="button" className="lean-tray-rowref" onClick={() => open(x.ref)}>
                    {x.ref.replace(/^.*#/, '')}
                  </button>
                </td>
                <td title={x.words}>
                  <span className="lean-tray-words">{x.words}</span>
                  {x.meta && <span className="lean-tray-meta">{x.meta}</span>}
                </td>
              </tr>
            ))}
            {c.count != null && c.count > recs.length && (
              <tr className="lean-tray-more">
                <td colSpan={2}>+ {fmt(c.count - recs.length)} more rows in {c.file}</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : null}
    </>
  )
}

function Highlight({ text, words }: { text: string; words: string }) {
  const at = words.length > 6 ? text.indexOf(words.slice(0, 40)) : -1
  if (at < 0) return <>{text}</>
  const end = Math.min(text.length, at + words.length)
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  )
}

function SeriesBars({ values }: { values: number[] }) {
  const hi = Math.max(0, ...values.map((v) => (typeof v === 'number' ? v : 0))) || 1
  const bw = Math.max(4, Math.min(28, 560 / values.length - 3))
  return (
    <svg className="lean-tray-series" width={values.length * (bw + 3)} height={64}>
      {values.map((v, i) => {
        const h = Math.max(1.5, ((typeof v === 'number' ? v : 0) / hi) * 48)
        return <rect key={i} x={i * (bw + 3)} y={52 - h} width={bw} height={h} rx={2} />
      })}
      <text x={0} y={63}>
        {values.length} values · max {fmt(hi)}
      </text>
    </svg>
  )
}

// ---------------------------------------------------------------- an explain card

function ExplainBody({ m }: { m: Prepared }) {
  const g = m.body || {}
  const refs = (g.refs || []).filter(isRef)
  return (
    <>
      {g.title && <p className="lean-tray-def lean-tray-def-title">{g.title}</p>}
      <div className="lean-tray-def chat-text">
        <CitedText text={g.body || 'No explainer was written for this term.'} onCite={(ref, label) => pushCite({ kind: 'cite', ref, label })} />
      </div>
      {g.program && <ExplainDrawing program={g.program} data={g.data} id={m.gloss || 'x'} />}
      {refs.length > 0 && (
        <div className="lean-tray-bit">
          <span className="lean-tray-bit-label">rests on</span>
          {refs.map((r) => (
            <button key={r} type="button" className="refchip refchip-value lean-mark" onClick={() => pushCite({ kind: 'cite', ref: r, label: r.replace(/^obj:/, '') })}>
              {r.replace(/^obj:/, '')}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function ExplainDrawing({ program, data, id }: { program: string; data: unknown; id: string }) {
  const [svg, setSvg] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const object = useMemo(() => ({ id: `explain-${id}`, version: 1, program, data: data || {} }), [program, data, id])
  useEffect(() => {
    let alive = true
    const w = columnsIn(Math.min(720, (box.current?.clientWidth || 600) - 8))
    void drawingOf(object, { w, mode: 'inline' })
      .then((d) => svgOf(d, { w }))
      .then((s) => alive && setSvg(s.svg))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [object])
  return <div ref={box} className="lean-tray-drawing" dangerouslySetInnerHTML={{ __html: svg }} />
}
