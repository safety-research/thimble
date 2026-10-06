// The worked examples of views (viewers/<name>/view.json and rows.json, whole), for tests that cannot read files.
// Written by tools/gen_view_examples.mjs; edit the example's JSON and run it again, not this.
import type { ViewData, ViewSpec } from '../hooks/viewspec'
import * as timeline from './view-examples/timeline'
import * as linkedSessions from './view-examples/linked-sessions'
import * as repository from './view-examples/repository'

export const VIEWERS: Record<string, { spec: ViewSpec; data: ViewData }> = {
  "timeline": timeline,
  "linked-sessions": linkedSessions,
  "repository": repository,
}
