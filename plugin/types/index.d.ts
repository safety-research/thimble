// thimble's values in $.state (the session's, kept across a reload of the hooks module), one block per module.

declare module 'claude-code' {
  interface PluginState {
    'thimble': {
      // ---- marks (marks/)
      /** a reply's marks and their checks, by the reply's key, its last text row (a session.append uuid of main's; the
       *  AssistantMessage's requestId): { key, turnId, rows, startedAt, settledAt, items: [{ n, row, words, start, end,
       *  sentence, status: 'checking' | 'verified' | 'corrected' | 'failed', shown, was?, reason?,
       *  failedBy?: 'check' | 'evidence' | 'none', evidence?, note?, repair?, narrowed?, rewrite? }] } (marks/store.ts Reply), kept on disk too */
      marks: StateFamily<unknown>
      /** the reply each text row with marks belongs to, by the row: the reply's key */
      marksRow: StateFamily<string>
      /** main's text rows of the turn that runs, until its reply's marks are in the store: [{ row, text, at }] */
      marksRows: { row: string; text: string; at: number }[]
      /** the checks that run, by the checker fork's agent: the reply's key and the marks this fork checks; `repair`: a
       *  check of one mark again, which x in the tray started, or thimble when the check failed it (`auto`) */
      marksRunning: Record<string, { agentId: string; key: string; turnId: string; marks: number[]; cwd: string; root: string; replyEnd: number; spawnedAt: number; repair?: boolean; auto?: boolean; thread?: string }>

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
      /** what the person opened inside a pane of the bar's, by kind: coverage {open, file} (panes/) */
      paneView: StateFamily<unknown>
      /** the failure line or a notice, until the person's next prompt (bar/notice.ts) */
      failLine: { kind: 'failed' | 'notice'; text: string; about?: string } | null

      // ---- labels (labels/)
      /** goes up when a label changes (Claude's `thimble label` command, a wave of the model's reads, the person's
       *  check): the labels pane reads the labels again (labels/labels.ts) */
      labelGen: number
      /** the ask before a large label run that waits for the person's choice (labels/use.ts): { root, name, ask, text,
       *  meta, units, sample, rest }, or null */
      labelAsk: { root: string; name: string; ask: string; text: string; meta: string; units: number; sample: number; rest: boolean } | null

      // ---- core (core/)
      /** what the side pane shows (core/pane.ts) */
      pane: { kind: string; args: unknown } | null
      /** the id of main's turn that runs, null when none runs (core/turn.ts) */
      mainTurn: string | null
      /** which agents are thimble's forks, and their kind (core/forks.ts) */
      forks: Record<string, 'checker' | 'designer' | 'thread' | 'fixer'>
      /** what Claude reads with the person's next prompt, by key (core/tell.ts) */
      tell: Record<string, string>
      /** the session's temp folder, as a real path (core/home.ts tempDir) */
      tempDir: string
      /** how far the session's change feed has been read (core/feed.ts) */
      feed: { file: string; bytes: number } | null

      // ---- answers (core/answers.ts): the record of each of main's turns and text rows, kept on disk too
      /** a turn of main's, by its id: { turnId, n, prompt: { text, by, row }, rows, answer, reason, startedAt, endedAt,
       *  labels: [{ name, args, toolUseId, seq, ok }], cards: [{ id, toolUseId, seq }], seq } (TurnRec) */
      answerTurn: StateFamily<unknown>
      /** the turns' ids, oldest first */
      answerTurns: string[]
      /** a text row of Claude's, by its row: { row, turnId, text, at, parts: { [feature]: its part } } (Msg) */
      answerMsg: StateFamily<unknown>
      /** the turn a text row belongs to, by the row */
      answerRowTurn: StateFamily<string>
      /** the answer the person picked for the keys with { and }, or null: the newest */
      answerSel: string | null

      // ---- the tray (tray/tray.ts)
      /** the cite and explain tray while it is open: { stack: [MarkRef & { open?: 'code' | null }] }, its top shown */
      tray: { stack: unknown[] } | null
      /** the card ] reached, which holds the keys: { row, card } */
      trayCard: { row: string; card: string } | null
      /** by main's turn: what its prompt was about when the person asked it with the tray open (`the citation "…"`) */
      trayAsked: StateFamily<string>

      // ---- side threads (threads/)
      /** a side thread, by its key (threads/thread.ts Thread): { id, key, agentId, scope, subject, root, status, asks,
       *  turns, sent?, error?, at }, kept on disk too; read by the pane that draws it, so it draws again at each change */
      thread: StateFamily<unknown>
      /** goes up when a thread changes: the bar's count and the thread list draw again */
      threadsGen: number

      // ---- fixes (fix/): the person's changes to their own thimble; the kernel keeps the records (fixes.jsonl)
      /** the fixes as `thimble fix list --json` last gave them, and a number that changes with each read (fixes.ts) */
      fixes: { fixes: unknown[]; on: boolean; live: string; version: string; count_on: number; pointed: boolean; gen: number } | null
      /** the line above the bar for one fix: ready, applied, off, failed, request, or a problem (fixes.ts FixLine) */
      fixLine: { id: number; kind: 'ready' | 'applied' | 'off' | 'failed' | 'request' | 'problem' | 'update'; said?: string } | null
      /** whether this session looked for a newer release already (register.ts) */
      fixUpdated: boolean
      /** the fixer agents that run: the fix's id, by the agent's id (fixer.ts) */
      fixers: Record<string, number>
      /** the start of the command each fix's fixer runs a shell command with, in the sandbox, by the fix's id */
      fixerBox: Record<string, string[]>
      /** what Your fixes shows (pane.tsx): the selected fix, the marked ones, whether the diff shows, or what s shared */
      fixView: { sel: number | null; marked: number[]; diff: boolean; share?: boolean } | null
      /** the fixes the last s shared, each with what `thimble fix share` said or why it did not (share.ts Shared) */
      fixShare: { ids: number[]; items: unknown[]; pending: boolean } | null
      /** the submit preview: the fixes it walks, the one it shows, and why a draft could not be made */
      fixSubmit: { ids: number[]; at: number; problem?: string } | null
      /** a fix's draft as the preview reads it, by the fix's id (pane.tsx) */
      fixDraft: StateFamily<unknown>

      // ---- squeeze (squeeze/): its records are each message's part `squeeze` (core/answers.ts)
      /** a record's state beside its text, by its id (a row, or `<host row>#cu` for a catch-up): { running, want,
       *  asked, error, reveal } (squeeze/term.ts SqzUi) */
      squeezeUi: StateFamily<unknown>
      /** what Claude was told of each record's version, and the version waiting for the next prompt, by its id */
      squeezeTold: Record<string, { told: string; pending: string | null }>
      /** the record the chips are open on, the picked chip, the chip at its edge, what is typed after +, whether a
       *  click gave the chips the keyboard, whether the bar says how to type a chip of one's own (squeeze/ui.ts) */
      squeezeOpen: { id: string; focus: string; edge: string | null; typing: string | null; held: boolean; hint: boolean } | null
      /** the chips the person typed this session, newest last */
      squeezeOwn: string[]
      /** the cards a squeeze changed: the copy each shows and the version it drew, the cards left out of the version
       *  shown, what the version shown did to each (squeeze/cards.ts) */
      squeezeCards: { shown: Record<string, { copy: string; v: number }>; hidden: string[]; did: Record<string, string> }

      // ---- claims (claims/term.ts): the conversation's claims, kept in its kept folder too (claims.json)
      /** { v, session, updated, claims, clusters, gaps } (claims/store.js) */
      claims: unknown
      /** when the count of claims last went up: the bar's count is bold for a moment after (claims/term.ts) */
      claimsBright: number | null
    }
  }
}
