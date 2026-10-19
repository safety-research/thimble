// FilesPane.tsx: 0.9's Files on lean's kernel. The views bar holds the File browser, Claims (the session's claims, drawn
// by the Claims pane, lean/panes/claims.js) and each view (a big card: a map, a trace or an explore view), as 0.9 holds its pages. The
// File browser lists the sources (`thimble sources`), each with what this session read of it (`thimble coverage`: computed,
// read, searched, named or not read), and reads a file's records through `thimble rows`, the rows this session read
// marked. Nothing here counts as Claude's reading: the page's reads go under the person's own session.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '@09/components/Icon'
import { Segmented } from '@09/components/Button'
import { PaneStatus } from '@09/components/PaneStatus'
import { Spinner } from '@09/components/Spinner'
import { api, fmt } from '../lib/api'
import { setState, useStore, type ObjectInfo } from '../lib/store'
import { VIEW_VERBS } from '../chat/Message'
import { useDrawn } from '../canvas/CardFace'
import { PaneView } from '../panes/PaneView'

interface Source {
  path: string
  kind: string
  rows: number
  lines: number
  size: number
}
interface Cov {
  path: string
  status: 'computed' | 'read' | 'searched' | 'named' | 'not read'
  rows: number
  lines: number
  computed: number
  read_lines: number
  shown: number
  searched: boolean
  matched: number
  queries: string[]
}

const glyph = (p: string): IconName => (/\.(jsonl|json)$/.test(p) ? 'braces' : /\.(csv|tsv|db|sqlite3?)$/.test(p) ? 'table' : /\.(md|txt)$/.test(p) ? 'text' : /\.(py|js|ts|sh)$/.test(p) ? 'code' : 'file')

export function FilesPane() {
  const view = useStore((s) => s.filesView)
  const objects = useStore((s) => s.objects)
  const views = useMemo(() => objects.filter((o) => VIEW_VERBS.has(String(o.verb))), [objects])
  const options = [
    { value: 'browser', label: 'File browser', icon: 'folder' as IconName },
    { value: 'claims', label: 'Claims', icon: 'graph' as IconName },
    ...views.map((v) => ({ value: `view:${v.id}`, label: v.title.replace(/^Trace · /, 'Trace · ').slice(0, 32), icon: 'view' as IconName })),
  ]
  const value = options.some((o) => o.value === view) ? view : 'browser'
  const shownView = value.startsWith('view:') ? views.find((v) => `view:${v.id}` === value) ?? null : null
  return (
    <div className="files-tab" data-panel="files">
      <div className="files-views" aria-label="Views">
        <Segmented label="Views" size="lg" value={value} onChange={(v) => setState({ filesView: v })} options={options} />
        <button type="button" className="btn btn-ghost btn-md files-views-new lean-new-view" title="Ask Claude for a view of these records: v under an answer makes one too" onClick={() => setState({ composerFill: { text: 'Make a view of ', at: Date.now() } })}>
          <Icon name="plus" size={14} />
          <span>New view</span>
        </button>
      </div>
      {value === 'browser' && <Browser />}
      {value === 'claims' && <ClaimsView />}
      {shownView && <BigView view={shownView} />}
    </div>
  )
}

// ---------------------------------------------------------------- the file browser

function Browser() {
  const info = useStore((s) => s.info)
  const want = useStore((s) => s.file)
  const rows = useStore((s) => s.rows)
  const [sources, setSources] = useState<Source[] | null>(null)
  const [cov, setCov] = useState<Record<string, Cov>>({})
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => {
    void api('sources').then((r) => (r.error ? setError(r.error) : setSources(r.sources || [])))
  }, [])
  // what the session read, again whenever its messages change (a turn read more)
  useEffect(() => {
    void api('coverage').then((r) => {
      if (r.error || !Array.isArray(r.files)) return
      setCov(Object.fromEntries(r.files.map((f: Cov) => [f.path, f])))
    })
  }, [rows.length])
  useEffect(() => {
    if (!want) return
    const [path, loc] = want.split('#')
    setOpen(path)
    const m = /^L(\d+)/.exec(loc || '')
    setAt(m ? Number(m[1]) : null)
    setState({ file: null })
  }, [want])
  // first the file this session read most of: computed over, then read, then the largest
  useEffect(() => {
    if (open || !sources?.length) return
    const rank = (s: Source) => ['computed', 'read', 'searched', 'named'].indexOf(cov[s.path]?.status ?? '')
    const by = [...sources].sort((a, b) => ((rank(a) + 5) % 5) - ((rank(b) + 5) % 5) || b.rows - a.rows)
    if (Object.keys(cov).length || sources.length === 1) setOpen(by[0].path)
  }, [sources, cov])
  const cur = sources?.find((s) => s.path === open) ?? null
  const totals = sources ? `${sources.length} files · ${fmt(sources.reduce((n, s) => n + (s.rows || 0), 0))} rows` : ''
  return (
    <>
      <div className="files-body">
        <aside className="files-side" style={{ width: 252 }}>
          <section className="files-side-tree">
            <div className="files-side-head">
              <button type="button" className="files-side-title" aria-expanded="true">
                <Icon name="chevron-right" size={14} className="files-caret" />
                <span className="files-side-name">{info?.folder || 'files'}</span>
              </button>
            </div>
            <div className="files-tree" role="tree">
              {error && <div className="files-empty">Could not list the files. {error}</div>}
              {!sources && !error && (
                <div className="files-empty">
                  <Spinner size={12} label="Loading" />
                </div>
              )}
              <div className="files-rows">
                {(sources || []).map((s) => (
                  <div key={s.path} role="treeitem" className={`files-row files-file${open === s.path ? ' active' : ''}`} style={{ paddingLeft: 28 }} onClick={() => (setOpen(s.path), setAt(null))} title={covLine(cov[s.path], s)}>
                    <Icon className="files-glyph" name={glyph(s.path)} size={13} />
                    <span className="files-name">{s.path}</span>
                    <CovMark c={cov[s.path]} />
                  </div>
                ))}
              </div>
            </div>
          </section>
          <Coverage sources={sources || []} cov={cov} />
        </aside>
        <div className="files-main">
          <div className="reader">
            <div className="reader-bar">
              {cur && (
                <span className="reader-tabs-wrap">
                  <span className="reader-tabs" role="tablist" aria-label="Open files">
                    <span className="reader-tab active">
                      <span className="reader-tab-pick">
                        <Icon name={glyph(cur.path)} size={13} className="reader-tab-glyph" />
                        <span className="reader-tab-name">{cur.path}</span>
                      </span>
                    </span>
                  </span>
                </span>
              )}
            </div>
            {cur ? <Reader key={cur.path} source={cur} cov={cov[cur.path]} at={at} /> : <div className="files-empty">Pick a file.</div>}
          </div>
        </div>
      </div>
      <PaneStatus name="Files" meta={cur ? <span className="pane-status-file">{cur.path}{cov[cur.path] ? ` · ${covLine(cov[cur.path], cur)}` : ''}</span> : ''} totals={totals} />
    </>
  )
}

/** What the session read of a file, in a few words (the kernel's file_line). */
function covLine(c: Cov | undefined, s?: Source): string {
  if (!c) return s ? `${fmt(s.rows)} rows` : ''
  const bits: string[] = []
  if (c.computed) bits.push(`computed over ${c.computed >= c.rows && c.rows > 0 ? 'all ' + fmt(c.rows) : fmt(c.computed) + ' of ' + fmt(c.rows)} rows${c.queries?.length ? ` (${c.queries.slice(0, 4).join(', ')})` : ''}`)
  if (c.read_lines) bits.push(`read ${fmt(c.read_lines)} of ${fmt(c.lines)} lines`)
  if (c.shown) bits.push(`${fmt(c.shown)} row${c.shown === 1 ? '' : 's'} shown`)
  if (c.searched && c.status !== 'computed') bits.push(`searched${c.matched ? ` (${c.matched} hits)` : ''}`)
  if (c.status === 'named' && !bits.length) bits.push('named in a shell command')
  if (!bits.length) bits.push(`not read (${fmt(c.rows)} rows)`)
  return bits.join('; ')
}

/** The share of a file the session read: a filled bar for rows computed or read, a hatched one for a search. */
function share(c?: Cov): number {
  if (!c || !c.rows) return 0
  if (c.computed) return Math.min(1, c.computed / c.rows)
  if (c.read_lines) return Math.min(1, c.read_lines / Math.max(1, c.lines))
  if (c.shown) return Math.min(1, c.shown / c.rows)
  return 0
}

function CovMark({ c }: { c?: Cov }) {
  if (!c) return null
  const p = share(c)
  const word = c.status === 'computed' ? (p >= 1 ? 'all' : `${Math.max(1, Math.round(p * 100))}%`) : c.status === 'read' ? `${c.shown || c.read_lines ? fmt(c.shown || c.read_lines) : ''}` : c.status === 'searched' ? 'searched' : c.status === 'named' ? 'named' : ''
  return (
    <span className={`lean-cov lean-cov-${c.status.replace(' ', '-')}`}>
      <span className="lean-cov-word">{word}</span>
      <span className="lean-cov-bar">
        <i style={{ width: `${c.status === 'searched' || c.status === 'named' ? 100 : Math.max(p > 0 ? 6 : 0, p * 100)}%` }} />
      </span>
    </span>
  )
}

function Coverage({ sources, cov }: { sources: Source[]; cov: Record<string, Cov> }) {
  if (!sources.length || !Object.keys(cov).length) return null
  const by = (st: string) => sources.filter((s) => cov[s.path]?.status === st)
  const rowsOf = (list: Source[]) => list.reduce((n, s) => n + (s.rows || 0), 0)
  const total = rowsOf(sources)
  const parts: [string, string, Source[]][] = [
    ['computed', 'computed over', by('computed')],
    ['read', 'read in part', by('read')],
    ['searched', 'searched', by('searched')],
    ['named', 'named', by('named')],
    ['not-read', 'not read', by('not read')],
  ]
  return (
    <section className="lean-coverage" aria-label="Coverage">
      <div className="files-side-head lean-coverage-head">
        <span className="files-side-title">
          <Icon name="chevron-right" size={14} className="files-caret" style={{ transform: 'rotate(90deg)' }} />
          <span className="files-side-name">Read by this session</span>
        </span>
      </div>
      <div className="lean-coverage-strip" title="the files' rows, by what this session read of them">
        {parts.map(([k, , list]) => (rowsOf(list) ? <i key={k} className={`lean-cov-${k}`} style={{ flex: rowsOf(list) / Math.max(1, total) }} /> : null))}
      </div>
      {parts
        .filter(([, , list]) => list.length)
        .map(([k, word, list]) => (
          <div key={k} className="lean-coverage-row">
            <span className={`lean-coverage-key lean-cov-${k}`} />
            <span className="lean-coverage-word">{word}</span>
            <span className="lean-coverage-n">
              {list.length} {list.length === 1 ? 'file' : 'files'} · {fmt(rowsOf(list))} rows
            </span>
          </div>
        ))}
    </section>
  )
}

interface Rec {
  ref: string
  line: number
  text: string
}

const PAGE = 60

function Reader({ source, cov, at }: { source: Source; cov?: Cov; at: number | null }) {
  const [recs, setRecs] = useState<Rec[]>([])
  const [from, setFrom] = useState(1)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'records' | 'raw'>('records')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Rec[] | null>(null)
  const [flash, setFlash] = useState<number | null>(at)
  const box = useRef<HTMLDivElement>(null)
  const load = async (start: number, replace: boolean) => {
    setBusy(true)
    const r = await api(`rows?path=${encodeURIComponent(source.path)}&from=${start}&n=${PAGE}`)
    setBusy(false)
    if (r.error) return
    setRecs((x) => (replace ? r.rows : [...x, ...r.rows.filter((y: Rec) => !x.some((z) => z.line === y.line))]))
    setFrom(start)
  }
  useEffect(() => {
    const start = at ? Math.max(1, at - 3) : 1
    setFlash(at)
    void load(start, true).then(() => requestAnimationFrame(() => box.current?.querySelector('.lean-rec.is-flash')?.scrollIntoView({ block: 'center' })))
  }, [source.path, at])
  const last = recs.length ? recs[recs.length - 1].line : 0
  const covered = cov && (cov.status === 'computed' ? cov.computed >= cov.rows : false)
  const search = async () => {
    if (!q.trim()) return setHits(null)
    const r = await api(`rows?path=${encodeURIComponent(source.path)}&search=${encodeURIComponent(q.trim())}&n=40`)
    setHits(r.error ? [] : r.rows)
  }
  return (
    <>
      <div className="lean-reader-tools">
        <form
          className="lean-find"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <Icon name="search" size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${source.path}`} />
        </form>
        {cov && <span className={`lean-reader-cov lean-cov-${cov.status.replace(' ', '-')}`}>{covLine(cov, source)}</span>}
        <span className="lean-spacer" />
        <Segmented label="Mode" value={mode} onChange={(v) => setMode(v as 'records' | 'raw')} options={[{ value: 'records', label: 'Records' }, { value: 'raw', label: 'Raw' }]} />
      </div>
      {hits && (
        <div className="lean-hits">
          <div className="lean-hits-head">
            {hits.length} {hits.length === 1 ? 'match' : 'matches'}
            {hits.length >= 40 ? ' (the first 40)' : ''}
            <button type="button" className="lean-linkish" onClick={() => setHits(null)}>
              close
            </button>
          </div>
          {hits.map((h) => (
            <button key={h.ref} type="button" className="lean-hit" onClick={() => (setHits(null), setFlash(h.line), void load(Math.max(1, h.line - 3), true))}>
              <span className="lean-hit-no">{h.line}</span>
              <span className="lean-hit-text">{h.text.slice(0, 200)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="lean-reader" ref={box} onScroll={(e) => {
        const el = e.currentTarget
        if (!busy && last < source.rows && el.scrollHeight - el.scrollTop - el.clientHeight < 400) void load(last + 1, false)
      }}>
        {from > 1 && (
          <button type="button" className="lean-reader-more" onClick={() => void load(1, true)}>
            ↑ from the first row
          </button>
        )}
        {recs.map((r) => (
          <Record key={r.line} r={r} raw={mode === 'raw'} flash={flash === r.line} covered={!!covered} />
        ))}
        {busy && (
          <div className="lean-reader-more">
            <Spinner size={12} label="reading" />
          </div>
        )}
        {!busy && last >= source.rows && recs.length > 0 && <div className="lean-reader-end">the last of {fmt(source.rows)} rows</div>}
      </div>
    </>
  )
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const HEAD_KEYS = ['label', 'name', 'user', 'author', 'agent', 'role', 'type', 'kind', 'page_id', 'title']
const TIME_KEYS = ['time', 'timestamp', 'ts', 'at', 'date', 'created', 'write_date']
const BODY_KEYS = ['body', 'text', 'content', 'message', 'summary', 'change_summary', 'value']

function Record({ r, raw, flash, covered }: { r: Rec; raw: boolean; flash: boolean; covered: boolean }) {
  const [all, setAll] = useState(false)
  const v = raw ? null : parse(r.text)
  const cls = `lean-rec${flash ? ' is-flash' : ''}${covered ? ' is-covered' : ''}`
  if (!v)
    return (
      <div className={cls} data-line={r.line}>
        <span className="lean-rec-no">{r.line}</span>
        <pre className="lean-rec-raw">{r.text}</pre>
      </div>
    )
  const head = HEAD_KEYS.map((k) => v[k]).filter((x) => typeof x === 'string' && x).slice(0, 2) as string[]
  const time = TIME_KEYS.map((k) => v[k]).find((x) => typeof x === 'string') as string | undefined
  const bodyKey = BODY_KEYS.find((k) => typeof v[k] === 'string' && (v[k] as string).trim())
  const body = bodyKey ? String(v[bodyKey]) : ''
  const rest = Object.entries(v).filter(([k, x]) => k !== bodyKey && !HEAD_KEYS.slice(0, 2).includes(k) && !TIME_KEYS.includes(k) && x != null && x !== '' && typeof x !== 'object')
  const long = body.split('\n').length > 8 || body.length > 900
  return (
    <div className={cls} data-line={r.line}>
      <span className="lean-rec-no">{r.line}</span>
      <div className="lean-rec-main">
        <div className="lean-rec-head">
          <Icon name="chevron-down" size={10} />
          <span>{[...head, time ? time.replace('T', ' ').replace(/:\d\d(\.\d+)?Z?$/, '') : ''].filter(Boolean).join(' · ')}</span>
        </div>
        {body && <div className={`lean-rec-body${long && !all ? ' is-cut' : ''}`}>{body}</div>}
        {long && (
          <button type="button" className="lean-linkish lean-rec-all" onClick={() => setAll((x) => !x)}>
            {all ? 'Show less' : 'Show all'}
          </button>
        )}
        <div className="lean-rec-fields">
          {rest.slice(0, 4).map(([k, x]) => (
            <span key={k} className="lean-rec-field">
              <span className="lean-rec-k">{k.replace(/_/g, ' ')}</span> {typeof x === 'number' ? fmt(x) : String(x).slice(0, 80)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Claims and the views

/** Claims: the Claims pane (lean/panes/claims.js), the same program the terminal's c opens, on the session's claims
 * store (thimble/claims/<session>.json); its hover and replay are this page's own: hover a claim for what it means, r replays the graph in
 * the order the claims were made, a click on the claim shown opens the message where it was said. */
function ClaimsView() {
  const rows = useStore((s) => s.rows)
  const latest = [...rows].reverse().find((r) => r.kind === 'assistant' && r.record)?.row || ''
  const claimSeed = useStore((s) => s.claimSeed)
  return (
    <>
      <div className="files-body is-view lean-claims-pane">
        <PaneView name="claims" args={{ row: latest }} focus seed={claimSeed ? { hover: claimSeed } : null} onClose={() => setState({ filesView: 'browser' })} />
      </div>
      <PaneStatus name="Files" meta="view · Claims" />
    </>
  )
}

/** A view: a big card, drawn at the pane's width. */
function BigView({ view }: { view: ObjectInfo }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setW(Math.max(600, el.clientWidth - 64))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const d = useDrawn(view.id, null, w, 'detail')
  return (
    <>
      <div className="files-body is-view lean-bigview" ref={box}>
        <div className="lean-bigview-page">
          <h2 className="lean-bigview-title">{view.title}</h2>
          {view.question && <p className="lean-bigview-q">{view.question}</p>}
          {!d && <Spinner size={14} label="drawing" />}
          {d?.error && <div className="lean-card-error">× {d.error}</div>}
          {d && !d.error && <div className="lean-svg" onClick={(e) => {
            const r = (e.target as Element).closest('[data-region]')?.getAttribute('data-region')
            if (r) setState({ surface: 'canvas', card: { id: view.id, v: null, region: r } })
          }} dangerouslySetInnerHTML={{ __html: d.svg }} />}
        </div>
      </div>
      <PaneStatus name="Files" meta={`view · ${view.title}`} totals={`${view.id} v${view.version}`} />
    </>
  )
}
