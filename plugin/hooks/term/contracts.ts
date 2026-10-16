// The terminal UI's contracts between its two lanes' files (SPEC-v2 C13): the shapes of the $.state values one file
// writes and another reads (their keys are declared in types/index.d.ts), and what each side exports. The transcript's
// side lives in activate.ts, settings.ts, tracker.ts and lib.ts; the panel's in band.tsx, views.ts, offramp.ts,
// coverageview.tsx, citesview.tsx, checksview.tsx and notices.tsx. Types only: nothing here runs.
import type { EngineInterface } from 'claude-code'

/** The hooks' `$`. */
export type Dollar = EngineInterface

/** The per-feature switches (`/config` → thimble, the browser's Settings; `thimble features`, C6). */
export type FeatureSettings = { autoActivate: boolean; viewProposals: boolean; labels: boolean; checks: boolean; citationMarks: boolean; coverage: boolean; cardCheck: boolean }
export const FEATURE_KEYS = ['autoActivate', 'viewProposals', 'labels', 'checks', 'citationMarks', 'coverage', 'cardCheck'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
/** 0.8.0's behavior: every feature on. */
export const FEATURES_ON: FeatureSettings = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }

/** thimble on in this session (C2's answer): the workspace, the folder, how it turned on and the session's role. */
export type Activated = { ws: string; path: string; cwd: string; via: string; role: 'main' | 'peer'; at: number }
/** What a session's tool calls saw of the data files (C7 `Summary`). */
export type CoverageSummary = { files: { seen: number; searched: number; never: number; total: number }; records: { seen: number; total: number; counted: boolean }; line: string }
/** One chat citation the transcript drew. */
export type CiteRow = { id: string; raw: string; display: string | null; ref: string; row: string; at: number }
/** A check's comment on a passage of one of Claude's answers (C9, in the terminal's spelling). `color` is the check's
 *  label palette place, 1-8. */
export type AnswerComment = {
  id: string
  check: string
  checkName: string
  color: number
  about: string
  turn: string
  row: string
  ref: string
  start: number
  end: number
  quote: string
  text: string
  details: string
  status: 'open' | 'dismissed'
  at: string
}
/** The panel's per-section counts last seen (as 0.8.0's homeSeen). */
export type SummarySeen = { cards: number; labels: number; docs: number; views: number; threads: number; checks: number; at: number }

// $.state keys under plugin 'thimble' (types/index.d.ts):
//   activated: Activated | null            set by the transcript at activation
//   settings: FeatureSettings              the transcript (settings.ts)
//   coverageLine: StateFamily<string>      by row uuid; the transcript
//   coverageSummary: CoverageSummary|null  the transcript
//   citeIndex: CiteRow[]                   the transcript
//   answerComments: AnswerComment[]        the transcript (read on tick when <ws>/answer-comments.json changes)
//   checksRunning: number                  the transcript (from C9 `running`)
//   checksOpen: string | null              the panel (the comment open in the panel; the transcript lights it 30%)
//   labelUnsure, seen, pressing, links     the panel

// The transcript's exports, for the panel:
//   isActive(): boolean                                                activate.ts
//   activateNow(cx, via): Promise<{ ok: boolean; error?: string }>     activate.ts
//   settingsNow(cx): Promise<FeatureSettings>                          settings.ts
//   isDataFile(cwd, path, codeTree): boolean                           activate.ts, the twin of coverage.is_data
//   clean(s): string                                                   lib.ts
// The panel's exports, for the transcript:
//   registerBand(on), registerPanelViews(on) (each builds its hooks' context with ctx.ts cxOf: a hooks module passes `$`
//   only to a function of its own file or one imported from the module's files), refreshSummary(cx), openInBrowser(cx, ref),
//   openCoverage(cx, folder?), openCitations(cx, pick?), openChecks(cx, commentId?), postNotice(cx, key, text, acts)
