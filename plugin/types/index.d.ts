// thimble's values in $.state (the session's, kept across a reload of the hooks module), one block per module.

declare module 'claude-code' {
  interface PluginState {
    'thimble': {
      // ---- marks (marks/)
      /** a reply's marks and their checks, by the reply's key, its last text row (a session.append uuid of main's; the
       *  AssistantMessage's requestId): { key, turnId, rows, startedAt, settledAt, items: [{ n, row, words, start, end,
       *  sentence, status: 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked', shown, was?, reason?,
       *  failedBy?, evidence?, note? }] } (marks/store.ts Reply), kept on disk too */
      marks: StateFamily<unknown>
      /** the reply each text row with marks belongs to, by the row: the reply's key */
      marksRow: StateFamily<string>
      /** main's text rows of the turn that runs: [{ row, text, at }] */
      marksRows: { row: string; text: string; at: number }[]
      /** the checks that run, by the checker fork's agent: the reply's key and the marks this fork checks */
      marksRunning: Record<string, { agentId: string; key: string; turnId: string; marks: number[]; cwd: string; root: string; replyEnd: number; spawnedAt: number }>

      // ---- cards (cards/)
      /** a card, by its id (cards/store.ts CardMeta): { id, version, title, toolUseId, agentId, anchorRow, keys, rows,
       *  columns, file, gen, error, calls: { [tool_use_id]: { version, error? } }, at } */
      card: StateFamily<unknown>
      /** a card's drawing as the runner made it, by the card's id: { gen, width, tree, seq } */
      cardTree: StateFamily<unknown>
      /** the card that takes keys first: the newest drawn, or the one clicked last */
      cardFocus: string | null
      /** the cards drawn on screen since the plugin loaded, which alone take keys */
      cardSeen: string[]
      /** the cards the designer fork drew under an answer, by the answer's row */
      cardsAt: Record<string, string[]>
      /** the card a call of the card tool drew or changed, by the call's tool_use_id: { id } */
      cardCall: StateFamily<unknown>

      // ---- v (designer/v.ts)
      /** a design v started, by its key: { key, anchorRow, agentId, status, at, until, error?, cards } */
      designs: StateFamily<unknown>
      /** the key of the design that runs now, which the bar names */
      designNow: string | null
      /** main's last answer row (the session.append uuid of main's last text row): what v draws under */
      answerRow: string | null

      // ---- the bar (bar/)
      /** thimble's own work while it runs: the glyph's frame and how many jobs run (bar/busy.ts) */
      busy: { frame: number; n: number }
      /** the bar's counts: the share of the folder's files Claude touched, in words, the labels, a number that changes
       *  with each count, and why the last count failed (bar/counts.ts) */
      counts: { coverage: string | null; labels: number; gen: number; error: string | null } | null
      /** what the person opened inside a pane of the bar's, by kind: coverage {open, file}, fixshare {diff} (panes/) */
      paneView: StateFamily<unknown>
      /** the failure line (f F) or a notice, until the person's next prompt (bar/fix.ts) */
      failLine: { kind: 'failed' | 'notice'; text: string; about?: string } | null
      /** the fix the person's thimble has now, with p and u (bar/fix.ts) */
      fixLine: { slug: string; title: string; said?: string } | null
      /** the fixes that work now (bar/fix.ts), for the busy line */
      fixes: { slug: string; title: string; kind: string }[]
      /** each fix as refreshFixes last saw it, and the one that was on (bar/fix.ts), kept across a reload of the plugin */
      fixSeen: { fixes: Record<string, { status: string; used: number; title: string }>; active: string | null }
      /** a fix's share as its preview reads it, by slug (bar/fix.ts); never the ask's id */
      fixShare: StateFamily<unknown>

      // ---- labels (labels/)
      /** goes up when a label changes (Claude's `thimble label` command, a wave of the model's reads, the person's
       *  check): the labels pane reads the labels again (labels/labels.ts) */
      labelGen: number

      // ---- core (core/)
      /** what the side pane shows (core/pane.ts) */
      pane: { kind: string; args: unknown } | null
      /** whether main's turn runs (core/turn.ts) */
      mainRuns: boolean
      /** which agents are thimble's forks, and their kind (core/forks.ts) */
      forks: Record<string, 'checker' | 'designer'>
      /** what Claude reads with the person's next prompt, by key (core/tell.ts) */
      tell: Record<string, string>
      /** the session's temp folder, as a real path (core/home.ts tempDir) */
      tempDir: string
      /** how far the session's change feed has been read (core/feed.ts) */
      feed: { file: string; bytes: number } | null
    }
  }
}
