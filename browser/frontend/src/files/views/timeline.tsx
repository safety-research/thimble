// The Timeline view: a file's records on one time axis, offered for any file whose first records carry a time under one
// key (the server's time key, backend source_events.time_hint: JSON lines, a CSV or TSV file, a JSON document's records
// such as an ATIF trajectory's steps). It scores TIMELINE_SCORE, under the Transcript and Table views, so it is the
// default only where neither fits, such as an event log whose records nest objects, and is offered in the switcher
// otherwise. It draws the whole file in a frame of its own (`whole`): the view kit's search, Filter by, Rows, Color by,
// time range and timeline over a table of the records, as the worked example plugin/viewers/timeline lays them out
// (backend files_timeline.html). The reader feeds the page (ViewerFrame's `host`): every record with a time and its
// values of the keys Color by offers in the Transcript and Table views (GET /source/events, colorKeys), Color by opening
// on the key those views open on (defaultChoice) and Rows on the next key with few values; a record that opens in the
// side panel is read whole (GET /ref). The labels that are on mark the records the table draws, and a citation of the
// file opens the record it names.
import { useMemo } from 'react'
import { api } from '../../lib/api'
import type { SourceEvents, SourceKey, SourceKind, TimeHint, TranscriptHint } from '../../lib/types'
import { colorKeys, defaultChoice, KEY_COLORS } from '../colorChoice'
import { useFilesFilter } from '../useLabels'
import { ViewerFrame, type FrameHost } from '../ViewerFrame'
import type { ViewDef, ViewProps } from './common'

/** the score of a file whose records carry a time: over Raw's 0.1 and a nested table's 0.05, under every other view */
export const TIMELINE_SCORE = 0.3

/** What the page is sent of the file's records (GET /source/events): the keys Color by offers (colorKeys) and each
 * record's values of them, and the choices the page opens on: Color by's the one Files' other views open on
 * (defaultChoice), Rows' the first other key with at most the palette's values. Pure. */
export function timelineAnswer(got: SourceEvents): SourceEvents & { initial: { color: string; rows: string } } {
  const offered = colorKeys(got.keys.map((k) => ({ ...k, at: [] }) as SourceKey))
  const at = offered.map((k) => got.keys.findIndex((x) => x.key === k.key))
  const first = defaultChoice(offered)
  const color = first.by === 'key' ? first.key : ''
  const rows = offered.find((k) => k.key !== color && k.values.length >= 2 && k.values.length <= KEY_COLORS && !k.more.values)?.key ?? ''
  return {
    ...got,
    keys: offered.map(({ at: _at, ...k }) => k),
    events: got.events.map((e) => ({ ...e, v: at.map((i) => e.v[i] ?? null) })),
    initial: { color, rows },
  }
}

function Timeline({ workspace, path, targetRef, labels }: ViewProps) {
  const filter = useFilesFilter(workspace)
  const host = useMemo<FrameHost>(
    () => ({
      page: () => api.timelinePage(workspace),
      records: async (query) => {
        const q = (query ?? {}) as { op?: string; ref?: string }
        if (q.op === 'record' && typeof q.ref === 'string') return { record: (await api.resolveRef(workspace, q.ref)).record }
        return timelineAnswer(await api.sourceEvents(workspace, path))
      },
    }),
    [workspace, path],
  )
  return (
    <ViewerFrame
      ws={workspace}
      slug={`files-timeline:${path}`}
      host={host}
      targetRef={targetRef}
      path={path}
      title="Timeline"
      labels={labels?.on}
      filter={filter}
      filterFiles={filter ? labels?.presence.get(filter.concept) : undefined}
      byId={labels?.byId}
    />
  )
}

function match(_path: string, kind: SourceKind, _sample: any[], _transcript?: TranscriptHint | null, time?: TimeHint | null): number {
  return kind !== 'forge' && time?.key ? TIMELINE_SCORE : 0
}

const def: ViewDef = { type: 'timeline', title: 'Timeline', match, component: Timeline, whole: true }
export default def
