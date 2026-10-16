// The terminal UI's contracts between its two lanes' files (SPEC-v2 C13): the shapes of the $.state values one file
// writes and another reads (declared with their keys in types/index.d.ts, which may import nothing, and re-exported
// here), the feature switches' names and defaults, and what each side exports. The transcript's side lives in
// activate.ts, settings.ts, tracker.ts and lib.ts; the panel's in band.tsx, views.ts, offramp.ts, coverageview.tsx,
// citesview.tsx, checksview.tsx and notices.tsx. Types and constants only: nothing here runs.
import type { EngineInterface } from 'claude-code'

/** The hooks' `$`. */
export type Dollar = EngineInterface

export type { Activated, AnswerComment, CiteRow, CoverageSummary, FeatureSettings, SummarySeen } from './types'
import type { FeatureSettings } from './types'

export const FEATURE_KEYS = ['autoActivate', 'viewProposals', 'labels', 'checks', 'citationMarks', 'coverage', 'cardCheck'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
/** 0.8.0's behavior: every feature on. */
export const FEATURES_ON: FeatureSettings = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }

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
