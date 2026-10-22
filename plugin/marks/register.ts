// register.ts: marks. Claude marks the claims of its reply as markdown links to `#` (`[352](#) of the [410](#) refund
// requests`); after each reply one checker fork verifies each mark with evidence, and a deterministic validator checks
// that evidence. The reply is drawn with its marks (purple underline, a spinner while checking, corrected words in
// place, red with × on failure), and a click on a mark opens its evidence in the side pane (kind `evidence`).
//
// The marks lane builds it here: message.js and view.ts (the reply's layout with marks, moved from the old shell and
// not yet wired), checker.ts, evidence.tsx. Until then this registers nothing.
import type { Register } from 'claude-code'

export const registerMarks: Register = () => {}
