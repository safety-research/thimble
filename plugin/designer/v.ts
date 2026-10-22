// v.ts: the designer step. At an empty prompt, v starts a background fork (core/forks.ts, kind `designer`) that lists a
// few forms for the answer v was pressed on, picks one, draws it as a card under that answer and fixes it from its text
// copy. One line above the prompt says it works; its last message never reaches main.
//
// The designer lane builds it here. Until then v types as any letter, and no design has an anchor.
import type { Register } from 'claude-code'

export const registerDesigner: Register = () => {}

/** The answer row a designer fork's cards draw under, or null for an agent that is no designer fork. */
export function designAnchor(_agentId: string | undefined): string | null {
  return null
}
