// Side threads: a question about a card, a citation or the last answer, answered by a subagent the mod starts, so
// the exchange stays out of main's chat. register.tsx draws the pane (the exchange, its answers drawn like replies:
// chips and cards) and offers the result back to main as one line in the prompt, which the analyst sends or not.
//
// This file holds the prompts and the record; the engine is in register.tsx (the validator follows `$` only into
// functions of the hooks module's own file). Engine: $.agent.spawn with the `fork` type, which inherits main's
// conversation, so it knows the cards and the reply; where a fork is refused, a general-purpose subagent given the
// guidance and the context. Each follow-up starts a new fork given the exchange so far (a resumed subagent's end would
// reach main as a task notification, and main would answer it in its chat).
import type { ChatThread, ChatThreadTurn } from '../types'

const RULES = [
  'Answer here, briefly, the way thimble-chat answers in the main conversation: numbers from code (run Python with Bash; a card with the helper when a chart or table answers it), every number and record cited as [[value|ref]].',
  'Do not change the corpus, and write only under .thimble-chat/.',
  'End with one line `FOR MAIN: <one sentence>` stating what you found; the analyst may pass that line to the main conversation.',
].join(' ')

function history(t: ChatThread): string {
  return t.turns
    .filter(x => x.state === 'done')
    .map(x => `Q: ${x.q}\nA: ${x.a}`)
    .join('\n\n')
}

export function forkPrompt(t: ChatThread, q: string): string {
  const past = history(t)
  return [
    'thimble-chat side thread. The analyst reads this exchange in a pane beside the main conversation; the main conversation does not see it.',
    `It is about ${t.label}:`,
    t.context,
    '',
    ...(past ? ['', 'The exchange so far in this side thread:', past] : []),
    '',
    `The analyst asks: ${q}`,
    '',
    RULES,
  ].join('\n')
}

export function freshPrompt(t: ChatThread, q: string, guide: string): string {
  return [guide, '', '---', forkPrompt(t, q)].join('\n')
}

export function lastTurn(t: ChatThread, patch: Partial<ChatThreadTurn>): ChatThread {
  const turns = t.turns.slice()
  const i = turns.length - 1
  if (i >= 0) turns[i] = { ...turns[i]!, ...patch }
  return { ...t, turns }
}

/** A thread as the markdown file it is saved to. */
export function threadFile(t: ChatThread): string {
  return [`# Side thread: ${t.label}`, '', t.context, '', ...t.turns.flatMap(x => [`## ${x.q}`, '', x.a || `(${x.state})`, ''])].join('\n')
}
