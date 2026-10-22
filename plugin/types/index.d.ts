// thimble's values in $.state (the session's, kept across a reload of the hooks module), one block per module. Each
// lane edits only its own block.

declare module 'claude-code' {
  interface PluginState {
    'thimble': {
      // ---- L1 marks
      /** a reply's marks and their checks, by the reply's row (the session.append uuid of a main text row; the
       *  AssistantMessage's requestId): { row, turnId, last (the reply's last text row: it holds the reply's counts and
       *  draws the footer), total, checking, startedAt, settledAt, failed, unchecked, items: [{ n, words, start,
       *  end, sentence, status: 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked', shown, was?, reason?,
       *  evidence? }] } (marks/checker.ts ReplyMarks) */
      marks: StateFamily<unknown>
      /** main's text rows of the turn that runs: [{ row, text, at }] */
      marksRows: { row: string; text: string; at: number }[]
      /** the checks that run, by the checker fork's agent: the reply's rows and the marks this fork checks */
      marksRunning: Record<string, { agentId: string; turnId: string; rows: string[]; marks: number[]; cwd: string; replyEnd: number; spawnedAt: number }>

      // ---- L2 cards
      /** a card, by its id (cards/store.ts CardMeta): { id, version, title, toolUseId, agentId, anchorRow, keys, rows,
       *  columns, file, gen, error, calls: { [tool_use_id]: { version, error? } }, at } */
      card: StateFamily<unknown>
      /** a card's drawing as the runner made it, by the card's id: { gen, width, tree, pointer } */
      cardTree: StateFamily<unknown>
      /** the card that takes keys */
      cardFocus: string | null
      /** the card a `/` search types into, and its words; `kept` once Enter kept it (its words leave the prompt box at
       *  the next edit) */
      cardSearch: { id: string; text: string; kept?: boolean } | null
      /** the cards the designer fork drew under an answer, by the answer's row */
      cardsAt: Record<string, string[]>
      /** the card a call of the card tool drew or changed, by the call's tool_use_id: { id } */
      cardCall: StateFamily<unknown>

      // ---- L4 v
      /** a design v started, by its key: { key, anchorRow, agentId, status, at, error?, cards } */
      designs: StateFamily<unknown>
      /** the key of the design that runs now, which the bar names */
      designNow: string | null
      /** main's last answer row (the session.append uuid of main's last text row): what v draws under */
      answerRow: string | null

      // ---- L5 bar
      /** thimble's own work while it runs: the glyph's frame and how many jobs run (bar/busy.ts) */
      busy: { frame: number; n: number }
      /** the bar's counts: the share of the folder's files Claude touched, in words, the labels, a number that changes
       *  with each count, and why the last count failed (bar/counts.ts) */
      counts: { coverage: string | null; labels: number; gen: number; error: string | null } | null
      /** whether main's conversation holds an answer v can draw a card of (bar/bar.tsx) */
      answered: boolean
      /** what the person opened inside a pane of the bar's, by kind: coverage {open, file}, fixshare {diff} (panes/) */
      paneView: StateFamily<unknown>
      /** the line whose fix keys the bar names (bar/fix.ts): a failure (f F), a fix in use (p u), or a notice */
      fixLine: { kind: 'failed'; text: string } | { kind: 'applied'; slug: string; title: string; said?: string } | { kind: 'notice'; text: string } | null
      /** the fixes that work now (bar/fix.ts), for the busy line */
      fixes: { slug: string; title: string; kind: string }[]
      /** each fix as refreshFixes last saw it, and the one that was on (bar/fix.ts), kept across a reload of the plugin */
      fixSeen: { fixes: Record<string, { status: string; used: number; title: string }>; active: string | null }
      /** a fix's share as its preview reads it, by slug (bar/fix.ts); never the ask's id */
      fixShare: StateFamily<unknown>

      // ---- L6 labels
      /** goes up when a label changes (Claude's `thimble label` command, a wave of the model's reads, the person's
       *  check): the labels pane reads the labels again (labels/labels.ts) */
      labelGen: number

      // ---- core (L0)
      /** what the side pane shows (core/pane.ts) */
      pane: { kind: string; args: unknown } | null
      /** which agents are thimble's forks, and their kind (core/forks.ts) */
      forks: Record<string, 'checker' | 'designer'>
      /** what Claude reads with the person's next prompt, by key (core/tell.ts) */
      tell: Record<string, string>
      /** how far the session's change feed has been read (core/feed.ts) */
      feed: { file: string; bytes: number } | null
    }
  }
}
