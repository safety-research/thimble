// The terminal UI's contracts between the 0.9.0 lanes (C13 of the build spec): the types the term files share, and the
// functions each owner exports, with the file that holds each. Types only: nothing here runs, so importing this file
// has no effect. A function is imported from the file named beside it, never from here.
//
//   term-transcript   activate.ts   isActive, activateNow, isDataFile
//                     settings.ts   settingsNow
//                     lib.ts        clean (noControls with bidi, zero-width and U+FEFF)
//   term-panel        band.tsx      registerBand
//                     views.ts      registerPanelViews, refreshSummary
//                     offramp.ts    openInBrowser
//                     coverageview.tsx  openCoverage;  citesview.tsx  openCitations;  checksview.tsx  openChecks
//                     notices.tsx   postNotice
//   runtime           ../thimble.ts bridgeActivated
//
// Register-time functions take only `on`: register gets no `$`, and a hook a term file registers builds its own Ctx from
// its own `$` with register.tsx's cxOf, imported by name (Claude Code refuses a module that passes `$` to a function it
// cannot find declared in or imported into the file, such as a parameter). Every other function takes the Ctx of the
// hook or handler that calls it.
//
// The $.state keys these values live under (plugin 'thimble') are declared in types/index.d.ts.
import type { EngineInterface, On } from 'claude-code'

import type { Ctx } from './ctx'
import type { Activated, FeatureSettings } from './types'

export type { Activated, AnswerComment, CiteRow, CoverageSummary, FeatureSettings, LabelUnsure, Links, Pressing, SummarySeen } from './types'

/** What turned thimble on (C2 `--via`). */
export type Via = 'data' | 'command' | 'tool' | 'launcher' | 'press'

/** A hook's context from its own `$` (register.tsx cxOf, which a term file imports by name). */
export type CxOf = (dollar: EngineInterface) => Ctx

// ---- term-transcript (activate.ts, settings.ts, lib.ts)
export type IsActive = () => boolean
export type ActivateNow = (cx: Ctx, via: Via) => Promise<{ ok: boolean; error?: string }>
export type SettingsNow = (cx: Ctx) => Promise<FeatureSettings>
/** The twin of backend coverage.is_data: whether `path` (inside `cwd`) is a data file. */
export type IsDataFile = (cwd: string, path: string, codeTree: boolean) => boolean
export type Clean = (s: string) => string

// ---- term-panel (band.tsx, views.ts, offramp.ts, coverageview.tsx, citesview.tsx, checksview.tsx, notices.tsx)
export type RegisterBand = (on: On) => void
/** drawsView/loadsView for the new panel views; called once from register.tsx. */
export type RegisterPanelViews = (on: On) => void
/** term-transcript's tick calls it when the labels, coverage, answers, cards or docs areas change (data.ts AREAS). */
export type RefreshSummary = (cx: Ctx) => Promise<void>
export type OpenInBrowser = (cx: Ctx, ref: string) => Promise<void>
export type OpenCoverage = (cx: Ctx, folder?: string) => Promise<void>
export type OpenCitations = (cx: Ctx, pick?: string) => Promise<void>
export type OpenChecks = (cx: Ctx, commentId?: string) => Promise<void>
/** A notice row in the band, and one toast. */
export type PostNotice = (cx: Ctx, key: string, text: string, acts: string[]) => void

// ---- runtime (plugin/hooks/thimble.ts)
/** Registers the thimble:* agent types and turns the bridge on; idempotent. */
export type BridgeActivated = (dollar: EngineInterface, a: Activated) => Promise<void>
