// intro.ts: the hint that says where thimble's settings are. It shows at the end of a session's first answer (bar/hints.ts
// remindAfterAnswer asks for it), when the person reads the answer and the bar has its keys, and goes as the bar's other
// hints go (bar/notice.ts hintLine): after a few seconds, at the next key thimble takes, or at the next prompt. Each new
// session shows it again, until the person has opened the settings once.
//
//   introText($)       the hint's words, or null once the settings were opened (or when the store cannot say)
//   introDone($)       the settings opened: no session shows the hint again
//
//   store: settingsOpened (true once the person opened the settings)
import type { EngineInterface } from 'claude-code'

import { fullscreenNow } from '../cards/draw'
import { failCleared } from './notice'

type Engine = EngineInterface

const OPENED = 'settingsOpened'

export const INTRO = 'click thimble for settings.'
/** In Claude Code's default layout, where no click reaches the bar (cards/draw.ts fullscreenNow). */
export const INTRO_TYPED = 'type /thimble-settings for settings.'

export async function introText($: Engine): Promise<string | null> {
  let opened: unknown = true
  try { opened = await $.store.get(OPENED) } catch { /* with no store to keep its end, the hint would never end: none */ }
  if (opened === true) return null
  return fullscreenNow() === false ? INTRO_TYPED : INTRO
}

export async function introDone($: Engine): Promise<void> {
  if ((await $.store.get(OPENED)) !== true) await $.store.set(OPENED, true)
  await failCleared($, 'intro')
}
