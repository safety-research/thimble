// The theme the page shows, reported to the server (PUT /ws/{c}/render/theme) whenever it changes, so the card harness
// draws a card offscreen in it (backend/app/render.py): an export's figures and the card check's pictures. While the
// server refuses a report, those cards keep the theme it had: a notice of this page's own (lib/notices) says what the
// server said, with Send, which puts the failure after /thimble-fix in main's composer, and the next report it takes
// clears it. A report with no answer adds nothing, since the server is down, which shell/ServerDown says, and neither
// does one that needs a sign-in, which shell/SignIn says.
import { api } from './api'
import { dismissNotice, PAGE_NOTICE, showPageNotice } from './notices'

/** The id of the notice that the server refused the theme. */
export const THEME_NOTICE = `${PAGE_NOTICE}theme`

/** The notice's words and Send's: {why} what the server said. */
export const THEME_REFUSED = "The server didn't take this theme, so exported cards keep the old colors: {why}. Send to thimble-fix?"
export const THEME_SEND = "The workbench's server didn't take the theme the page shows (paper {paper}, accent {accent}): {why}. Make the server take every paper and accent the page offers."

let shown = false

/** Report the paper and accent of workspace `ws`'s page to the server: a notice while it refuses them, cleared by the
 * next report it takes. */
export async function reportTheme(ws: string, paper: string, accent: string): Promise<void> {
  try {
    await api.reportTheme(ws, paper, accent)
  } catch (e) {
    // lib/api: an answer's error starts with its status
    const m = /^(\d{3}) ([\s\S]*)$/.exec((e as Error)?.message ?? '')
    if (!m || m[1] === '401') return
    const why = m[2].trim().replace(/\.$/, '')
    const words: Record<string, string> = { why, paper, accent }
    const fill = (t: string) => t.replace(/\{(why|paper|accent)\}/g, (_, k: string) => words[k])
    shown = true
    showPageNotice({ id: THEME_NOTICE, key: THEME_NOTICE, text: fill(THEME_REFUSED), action: { label: 'Send', do: 'thimble-fix', text: fill(THEME_SEND) } })
    return
  }
  if (shown) {
    shown = false
    void dismissNotice(ws, { id: THEME_NOTICE })
  }
}
