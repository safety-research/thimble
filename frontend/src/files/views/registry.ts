// The built-in file views, scored per file over a sample of its records and the server's transcript sniff. The scores
// order the defaults: a database file and a Claude Code stream score 1, a file the sniff is sure reads as a transcript
// 0.95 and one it only offers it for 0.5, a markdown file 0.9 (rendered), flat records that share their keys 0.85 or 0.7
// (table), records with a time 0.3 (timeline, the server's time key), Raw 0.1, so it stands when nothing else fits, and
// records that are objects but not flat 0.05 (table, offered under Raw). The switcher lists every view with a positive
// score.
import type { SourceKind, TimeHint, TranscriptHint } from '../../lib/types'
import type { ViewDef } from './common'
import forge from './forge'
import raw from './raw'
import table from './table'
import text from './text'
import timeline from './timeline'
import transcript from './transcript'

export const VIEWS: ViewDef[] = [raw, table, text, transcript, forge, timeline]
const byType = new Map(VIEWS.map((v) => [v.type, v]))

export function viewByType(type: string | undefined | null): ViewDef | undefined {
  return type ? byType.get(type) : undefined
}

export interface Scored {
  def: ViewDef
  score: number
}

export function scoreViews(path: string, kind: SourceKind, sample: any[], transcript?: TranscriptHint | null, time?: TimeHint | null): Scored[] {
  return VIEWS.map((def) => {
    let score = 0
    try {
      const s = Number(def.match(path, kind, sample, transcript, time))
      score = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0
    } catch (e) {
      console.warn(`view ${def.type}: match() threw`, e)
    }
    return { def, score }
  })
}

/** The best view: the highest positive score, else Raw. */
export function pickView(scored: Scored[]): ViewDef {
  let best: Scored | undefined
  for (const s of scored) if (s.score > 0 && (!best || s.score > best.score)) best = s
  return best?.def ?? raw
}
