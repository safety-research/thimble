// messages.mjs: the words that name the messages a look reads (observer.ts), so the fork finds each in the conversation.
// Pure: the workbench's look (browser/backend/app/look_of.mjs) names its answers with the same words.
//
//   messagesText(msgs) -> "Read this message of Claude's, above in the session: ..." for the messages of one look, each
//                         {kind: 'answer' | 'reply', text, turnNo, prompt: {text, by}, catchUp?}
import { isPersonPrompt, oneLine } from '../core/answers.mjs'

const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** What prompted a message's turn, in a clause: the analyst's question, or a report the session got. */
function promptedBy(p) {
  const q = oneLine(p?.text, 300)
  if (isPersonPrompt(p?.by)) return q ? `It answers the analyst's message "${q}".` : ''
  if (/notification|peer/.test(String(p?.by ?? ''))) return "It answers a report the session got (a background task's or another agent's), not a message of the analyst's."
  return q ? `It answers "${q}".` : ''
}

/** The messages a look reads, named so the fork finds each in the conversation: its kind, its turn, its first words. */
export function messagesText(msgs) {
  const one = m => {
    // a catch-up is not in the session above: its words stand here, and it is what the analyst reads of the replies
    if (m.catchUp) {
      const n = m.catchUp.split('\n').length
      return `A catch-up thimble wrote of Claude's messages since the analyst's last prompt (${n} line${n === 1 ? '' : 's'}). The analyst reads it below those messages, in place of reading them. It is not in the session above; these are its words:\n${cut(m.catchUp, 6000)}`
    }
    const begins = oneLine(m.text, 140)
    const n = m.text.split('\n').length
    const lines = `${n} line${n === 1 ? '' : 's'}`
    const what = m.kind === 'answer'
      ? `Claude's answer at the end of turn ${m.turnNo}, which begins "${begins}" (${lines}). ${promptedBy(m.prompt)}`
      : `Words Claude wrote to the analyst in the middle of turn ${m.turnNo}, before it went on working, which begin "${begins}" (${lines}).`
    return what.trim()
  }
  if (msgs.length === 1) return `Read this message of Claude's, above in the session: ${one(msgs[0])}`
  return [`Read these ${msgs.length} messages of Claude's, above in the session, in order. They came while you read the one before them:`, ...msgs.map((m, i) => `${i + 1}. ${one(m)}`)].join('\n')
}
