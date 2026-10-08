// The banner at the top of the chat while main runs outside thimble's fence: a session `thimble` did not start (a plain
// `claude` with /thimble), or one that runs without thimble's sandbox. Its subagents can then change the analyst's
// files, and thimble's agents cannot start in it (a Start there is refused as `not-launched`). It reads main's meta
// (`launched`, `fenced`); a meta that does not say shows nothing.
import { Icon } from '../components/Icon'
import type { ChatMeta } from '../lib/types'

/** The plain-`claude` warning, as /thimble prints it in such a session. */
export const UNFENCED_LINE =
  "thimble: WARNING - this session was not started with `thimble`, so it and its subagents run without thimble's sandbox and can change your files, and thimble's agents cannot start in it. Quit and run `thimble` in this folder."

/** The warning for a session `thimble` started that runs without thimble's sandbox all the same. */
export const NO_SANDBOX_LINE =
  "thimble: WARNING - this session runs without thimble's sandbox, so it and its subagents can change your files, and thimble's agents cannot start in it. Quit and run `thimble` in this folder."

/** The banner's line for main's meta, or null while main runs inside thimble's fence (or the meta does not say). Only
 * an attached session is judged. Pure. */
export function unfencedLine(main: Pick<ChatMeta, 'attached' | 'launched' | 'fenced'> | null | undefined): string | null {
  if (!main?.attached) return null
  if (main.launched === false) return UNFENCED_LINE
  if (main.fenced === false) return NO_SANDBOX_LINE
  return null
}

export function UnfencedBanner({ main }: { main: Pick<ChatMeta, 'attached' | 'launched' | 'fenced'> | null | undefined }) {
  const line = unfencedLine(main)
  if (!line) return null
  return (
    <div className="chat-unfenced" role="alert" data-launched={main?.launched === false ? 'false' : undefined}>
      <Icon name="warning" size={13} className="chat-unfenced-ico" />
      <span>{line}</span>
    </div>
  )
}
