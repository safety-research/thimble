// The page: one html document in a sandboxed frame (`sandbox=""`, no scripts, an opaque origin) in the page's theme,
// sized to its content. The shown frame cannot be read, so a hidden inert copy (`allow-same-origin`, still no scripts)
// is measured for height and overflow. Under the frame, the page's claims as prose and the code drawer. Loaded on demand
// with the editor's chunk.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { CodeArea } from '../components/Code'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { useFrameFonts } from '../lib/frame'
import { track } from '../lib/telemetry'
import { useTheme } from '../lib/theme'
import type { PageDoc } from '../lib/types'
import type { CheckLook, DocComment } from './checkComments'
import { EvidencePop, useEvidence } from './Evidence'
import { clampPageHeight, PAGE_MIN_HEIGHT, pageDocument, pageTokens } from './pageFrame'
import { Prose } from './Prose'

export interface PageViewProps {
  ws: string
  slug: string
  /** null before the writer or the analyst made the page */
  doc: PageDoc | null
  /** the code drawer is open */
  drawer: boolean
  /** the page's open comments, the checks that are on, how their checks are drawn, and the comment the Checks
   * pane picked */
  comments: readonly DocComment[]
  on: ReadonlySet<string>
  look: CheckLook
  picked: DocComment | null
  onSaved: (doc: PageDoc) => void
}

export function PageView({ ws, slug, doc, drawer, comments, on, look, picked, onSaved }: PageViewProps) {
  const { resolved, key } = useTheme()
  const html = doc?.html ?? ''
  // the frame waits for the app's faces, so the page is never drawn first in a fallback font
  const fonts = useFrameFonts()
  const shown = useMemo(() => (html && fonts != null ? pageDocument(html, resolved, pageTokens(), fonts) : ''), [html, resolved, key, fonts]) // key: the tokens are read again when the paper or the accent changes
  const [height, setHeight] = useState(PAGE_MIN_HEIGHT)
  const [wide, setWide] = useState(false)
  const measure = useRef<HTMLIFrameElement | null>(null)
  const read = useCallback(() => {
    const d = measure.current?.contentDocument
    if (!d) return
    const h = Math.max(d.documentElement?.scrollHeight ?? 0, d.body?.scrollHeight ?? 0)
    if (h > 0) setHeight(clampPageHeight(h))
    // wider than the frame: the page scrolls sideways inside it, which the fade at its right edge says
    const w = Math.max(d.documentElement?.scrollWidth ?? 0, d.body?.scrollWidth ?? 0)
    setWide(w > (d.documentElement?.clientWidth ?? w) + 1)
  }, [])
  // the column's width changes the page's height: the hidden frame follows the column, so it is measured again
  useEffect(() => {
    const el = measure.current
    if (!el || !shown) return
    const ro = new ResizeObserver(() => read())
    ro.observe(el)
    return () => ro.disconnect()
  }, [read, shown])

  const [code, setCode] = useState(html)
  const base = useRef(html)
  // a new generation replaces the field's text unless the analyst is mid-edit
  useEffect(() => {
    if (code === base.current) setCode(html)
    base.current = html
  }, [html]) // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const saved = await docsApi.putHtml(ws, slug, code)
      track('ui-click', { target: `report:${slug}`, detail: { action: 'page-save', chars: code.length } })
      onSaved(saved)
    } catch (e) {
      bus.emit('toast', { text: `Could not save the page. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const ev = useEvidence(comments, on, look, picked)
  const claims = doc?.claims ?? []
  // a comment picked in the Checks pane: its claim scrolls into view
  const claimsEl = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!picked) return
    claimsEl.current?.querySelector(`[data-sid="${CSS.escape(picked.sid)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [picked])

  return (
    <div className="wu-view">
      <div className="wu-pagedoc" data-page={slug}>
        <div className="wu-pagedoc-col">
          {shown && (
            <div className={`wu-page-frames${wide ? ' wu-page-wide' : ''}`}>
              <iframe className="wu-page-frame" sandbox="" srcDoc={shown} title={doc?.title || 'page'} style={{ height }} />
              <iframe ref={measure} className="wu-page-measure" sandbox="allow-same-origin" srcDoc={shown} title="" aria-hidden="true" tabIndex={-1} onLoad={read} />
            </div>
          )}
          {claims.length > 0 && (
            <div className="wu-page-claims" ref={claimsEl} onMouseOver={ev.onOver} onMouseLeave={ev.onLeave}>
              <span className="label">claims</span>
              {claims.map((c) => (
                <Prose key={c.id} ws={ws} slug={slug} sentences={[c]} flags={ev.flags} className="wu-page-claim" />
              ))}
            </div>
          )}
          {drawer && (
            <div className="wu-drawer" role="region" aria-label="Code">
              <section className="wu-drawer-section">
                <span className="label">html</span>
                <CodeArea lang="xml" mono block rows={12} maxHeight={560} autoGrow className="wu-page-code" value={code} onChange={setCode} spellCheck={false} aria-label="HTML" />
                <div className="wu-drawer-actions">
                  <Button size="sm" icon="check" busy={saving} disabled={code === html} onClick={() => void save()}>
                    save
                  </Button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
      <EvidencePop comments={ev.hovered} look={look} />
    </div>
  )
}
