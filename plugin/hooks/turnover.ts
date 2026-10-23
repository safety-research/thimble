// turnover.ts: everything thimble shows the person or tells Claude belongs to the Claude Code conversation
// (conversation.ts gives its key). At a load of the plugin each module's session.start hook reads back what the
// conversation kept. A /clear or a /resume inside a running Claude Code changes the conversation with no session.start:
// followConversation notices the new key (watch.ts asks at the end of the old session, at each prompt, at each turn of
// main's and before each Bash call), and each module then drops what it held of the earlier conversation and reads
// back what the new one kept, before the hook that asked goes on. The earlier conversation's records stay in its kept
// folder, so a /resume back to it finds them.
//
// Each module's part is called by name: Claude Code follows `$` only into functions a file declares or imports.
import type { EngineInterface } from 'claude-code'

import { turnCounts } from '../bar/counts'
import { promptTyped } from '../bar/notice'
import { turnCards } from '../cards/store'
import { turnClaims } from '../claims/term'
import { turnAnswers } from '../core/answers'
import { turnPane } from '../core/pane'
import { turnTell } from '../core/tell'
import { turnDesigner } from '../designer/v'
import { turnLabels } from '../labels/labels'
import { turnLabelUse } from '../labels/use'
import { restoreMarks } from '../marks/store'
import { turnObserver } from '../observer/observer'
import { turnSqueeze } from '../squeeze/seam'
import { turnThreads } from '../threads/thread'
import { turnTray } from '../tray/tray'
import { conversationTurned } from './conversation'

type Engine = EngineInterface

/** The asks, one at a time: a caller goes on only after a turnover another caller started has ended. */
let chain: Promise<void> = Promise.resolve()

/** The conversation may have changed: when it did, every module turns over to it, once, before this resolves. */
export function followConversation($: Engine): Promise<void> {
  const p = chain.then(() => step($))
  chain = p.catch(() => undefined)
  return p
}

async function step($: Engine): Promise<void> {
  if (await conversationTurned($)) await turnOver($)
}

/** Each module's part; one that fails leaves the others to turn over. */
async function turnOver($: Engine): Promise<void> {
  try { await turnTell($) } catch { /* the texts that wait */ }
  try { await turnAnswers($) } catch { /* the answers */ }
  try { await turnPane($) } catch { /* the side pane */ }
  try { await turnDesigner($) } catch { /* v */ }
  try { await turnCards($) } catch { /* the cards */ }
  try { await restoreMarks($) } catch { /* the citations */ }
  try { await turnLabelUse($) } catch { /* the label rows and the ask */ }
  try { await turnLabels($) } catch { /* the labels pane and the model's reads */ }
  try { await turnObserver($) } catch { /* the observer's looks */ }
  try { await turnSqueeze($) } catch { /* squeeze */ }
  try { await turnClaims($) } catch { /* the claims */ }
  try { await turnThreads($) } catch { /* the side threads */ }
  try { await turnTray($) } catch { /* the tray */ }
  try { await promptTyped($) } catch { /* the failure line */ }
  try { await turnCounts($) } catch { /* the bar's counts */ }
}
