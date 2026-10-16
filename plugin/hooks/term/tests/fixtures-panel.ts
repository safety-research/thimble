// The panel tests' fixtures (term-panel lane): everything tests/fixtures.ts has, and the mounts the panel's tests share
// (the pane, the band above the prompt), so a new panel test needs no copy of them.
export * from './fixtures'

/** The panel's pane id (term.ts PANEL). */
export const PANEL = 'thimble'

/** The panel's pane mounted on the terminal, `columns` wide with `rows` body rows (docked, focused). */
export function paneAt(columns = 120, rows = 40, bodyColumns = 96) {
  return { plugin: 'thimble', component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns, placement: 'dock', scroll: { bodyRows: rows }, view: {} } } as never
}

/** The band above the prompt mounted on the terminal, `columns` wide. */
export function aboveAt(columns = 140) {
  return { plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns - 10, scroll: { bodyRows: 10 }, view: {} } } as never
}
