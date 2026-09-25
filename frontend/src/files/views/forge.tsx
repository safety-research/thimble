// The Database view: a sqlite file's tables, paged rows, a row's detail and a free SQL box.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button, Segmented } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { TextArea } from '../../components/Field'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import type { SourceKind } from '../../lib/types'
import { compact, errMsg, type ViewDef, type ViewProps } from './common'

const PAGE = 100
type Rows = { table: string; columns: string[]; rows: any[][]; pk: string; total: number }
type Row = Record<string, any>
type DbRef = { kind: 'table'; table: string } | { kind: 'row'; table: string; pk: string }

function cell(v: any) {
  if (v === null || v === undefined) return <span className="dim">null</span>
  return compact(v, 80)
}

/** The table or row a ref names when it points into `path`. */
export function dbRefInto(ref: string, path: string): DbRef | null {
  const r = ref.trim()
  const i = r.indexOf('#')
  if (i < 0 || r.slice(0, i) !== path) return null
  const m = r.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\/(.+))?$/)
  if (!m) return null
  return m[2] ? { kind: 'row', table: m[1], pk: m[2] } : { kind: 'table', table: m[1] }
}

const toObj = (columns: string[], row: any[]): Row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))
const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`

function Grid({ path, table, columns, rows, keyIdx, selectedKey, onRow, tableRef }: { path: string; table?: string; columns: string[]; rows: any[][]; keyIdx?: number; selectedKey?: any; onRow?: (row: any[]) => void; tableRef?: RefObject<HTMLTableElement | null> }) {
  return (
    <table className="reader-grid" ref={tableRef}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const selected = keyIdx != null && selectedKey !== undefined && r[keyIdx] === selectedKey
          const anchor = table && keyIdx != null && keyIdx >= 0 ? `${path}#${table}/${String(r[keyIdx])}` : undefined
          return (
            <tr key={i} className={selected ? 'reader-row-selected' : undefined} onClick={onRow ? () => onRow(r) : undefined} data-anchor={anchor}>
              {r.map((v, j) => (
                <td key={j} className={j === keyIdx ? 'reader-grid-key' : undefined}>
                  {cell(v)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function ForgeBrowser({ workspace, path, targetRef }: ViewProps) {
  const forRef = targetRef ? dbRefInto(targetRef, path) : null
  const [tables, setTables] = useState<{ name: string; row_count: number }[]>([])
  const [table, setTable] = useState<string | undefined>(forRef?.table)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<Rows | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ table: string; row: Row } | null>(null)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [sql, setSql] = useState('')
  const [sqlRes, setSqlRes] = useState<{ columns: string[]; rows: any[][]; truncated: boolean } | null>(null)
  const [sqlErr, setSqlErr] = useState<string | null>(null)
  const [sqlBusy, setSqlBusy] = useState(false)
  const gridRef = useRef<HTMLTableElement | null>(null)

  useEffect(() => {
    let alive = true
    api
      .forgeTables(workspace, path)
      .then((t) => {
        if (!alive) return
        setTables(t)
        setTable((cur) => cur ?? t[0]?.name)
        if (t[0]) setSql((cur) => cur || `SELECT * FROM ${quoteId(t[0].name)} LIMIT 20`)
      })
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [workspace, path])

  useEffect(() => {
    if (!forRef) return
    setTable(forRef.table)
    setOffset(0)
    if (forRef.kind === 'row') {
      api
        .resolveRef(workspace, targetRef!)
        .then((res) => res.record && typeof res.record === 'object' && setDetail({ table: forRef.table, row: res.record }))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, path, targetRef])

  useEffect(() => {
    if (!table) return
    let alive = true
    api
      .forgeRows(workspace, path, table, offset, PAGE)
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(null)
      })
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [workspace, path, table, offset])

  const runSql = async () => {
    setSqlBusy(true)
    setSqlErr(null)
    try {
      setSqlRes(await api.forgeQuery(workspace, path, sql))
    } catch (e) {
      setSqlErr(errMsg(e))
    } finally {
      setSqlBusy(false)
    }
  }
  const pk = data && data.table === table ? data.pk : undefined
  const pkIdx = data && pk ? data.columns.indexOf(pk) : -1
  const detailKey = detail && pk && detail.table === table ? detail.row[pk] : undefined
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1
  const page = Math.floor(offset / PAGE) + 1
  return (
    <div className="reader-forge">
      <div className="reader-bar reader-forge-bar">
        {tables.length > 0 && table && (
          <Segmented
            label="Table"
            size="md"
            className="reader-forge-tables"
            value={table}
            onChange={(t) => {
              setTable(t)
              setOffset(0)
            }}
            options={tables.map((t) => ({
              value: t.name,
              label: (
                <>
                  <span className="mono">{t.name}</span>
                  <span className="reader-count">{t.row_count.toLocaleString()}</span>
                </>
              ),
            }))}
          />
        )}
        <span className="reader-spacer" />
        <Chip kind="plain" icon="terminal" active={sqlOpen} className="reader-sql-toggle" onClick={() => setSqlOpen((o) => !o)}>
          SQL
        </Chip>
      </div>
      {sqlOpen && (
        <div className="reader-sql">
          <TextArea
            mono
            block
            rows={3}
            value={sql}
            onChange={setSql}
            aria-label="SQL"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void runSql()
            }}
            spellCheck={false}
          />
          <div className="reader-sql-actions">
            <Button variant="primary" size="sm" icon="run" busy={sqlBusy} onClick={() => void runSql()}>
              Run
            </Button>
            {sqlRes && (
              <span className="dim">
                {sqlRes.rows.length} rows{sqlRes.truncated ? ' (truncated)' : ''}
              </span>
            )}
            {sqlErr && <span className="reader-error-text">{sqlErr}</span>}
          </div>
          {sqlRes && (
            <div className="reader-sql-result">
              <Grid path={path} columns={sqlRes.columns} rows={sqlRes.rows} />
            </div>
          )}
        </div>
      )}
      <div className="reader-forge-main">
        <div className="reader-forge-rows">
          {error && <div className="reader-error-text">{error}</div>}
          {data && data.table === table && (
            <>
              {pages > 1 && (
                <div className="reader-pager">
                  <Button variant="icon" size="sm" icon="chevron-left" title="Previous" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
                  <span className="dim">
                    page {page} of {pages}
                  </span>
                  <Button variant="icon" size="sm" icon="chevron-right" title="Next" aria-label="Next page" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} />
                </div>
              )}
              <Grid path={path} table={table} columns={data.columns} rows={data.rows} keyIdx={pkIdx} selectedKey={detailKey} tableRef={gridRef} onRow={(r) => setDetail({ table: table!, row: toObj(data.columns, r) })} />
            </>
          )}
          {!data && !error && <Spinner size={10} label="Loading" />}
        </div>
        {detail && (
          <aside className="reader-forge-detail">
            <div className="reader-forge-detail-head">
              <span className="mono">
                {detail.table}
                {detailKey !== undefined ? `/${detailKey}` : ''}
              </span>
              <span className="reader-spacer" />
              <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" className="reader-forge-detail-close" onClick={() => setDetail(null)} />
            </div>
            <table className="reader-kv">
              <tbody>
                {Object.entries(detail.row).map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td className="reader-kv-val">{v === null || v === undefined ? <span className="dim">null</span> : typeof v === 'string' ? v : JSON.stringify(v, null, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        )}
      </div>
    </div>
  )
}

function match(_path: string, kind: SourceKind): number {
  return kind === 'forge' ? 1 : 0
}

const def: ViewDef = { type: 'forge', title: 'Database', match, component: ForgeBrowser }
export default def
