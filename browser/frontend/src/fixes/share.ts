// share.ts: Share on a fix (backend app/fix_share.py), as s in the terminal's Your fixes. Claude writes the issue's
// title, what was wrong and how it was fixed; thimble's privacy check takes the analyst's names and values out; the
// share page opens in a new tab. Its one button opens GitHub's new-issue page with the text filled in, and the analyst
// pastes a screenshot and presses Submit there. Nothing is sent from thimble.
import { claimKey, describeDetail, signInNeeded } from '../lib/api'
import { apiUrl } from '../lib/browserKey'

/** What the server said of a share: the title after the check, what the check took out, GitHub's link with the text, the
 *  page's address, and why Claude wrote no text when it did not (`note`). */
export type Shared = { id: number; title: string; took: string; url: string; shortened: boolean; text: string; page: string; note: string }

/** POST /api/fixes/{id}/share. `tab`, a tab opened at the click (so no pop-up blocker stops it), then shows the page;
 *  on a failure it closes. */
export async function shareFix(id: number, ws: string | null, tab: Window | null = null): Promise<Shared> {
  try {
    await claimKey()
    const res = await fetch(apiUrl(`/api/fixes/${id}/share`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws }) })
    if (!res.ok) {
      await signInNeeded(res)
      let detail = res.statusText
      try {
        detail = describeDetail((await res.json()).detail)
      } catch {
        /* the status text stands */
      }
      throw new Error(`Fix ${id} was not shared: ${detail}`)
    }
    const out = (await res.json()) as Shared
    if (tab) tab.location.href = apiUrl(out.page)
    return out
  } catch (err) {
    tab?.close()
    throw err
  }
}

/** The line under Share once it worked: what the check took out, and where the page is. Pure. */
export function sharedLine(s: Pick<Shared, 'took' | 'note' | 'shortened'>, opened: boolean): string {
  const parts = [`Privacy check: ${s.took}.`, opened ? 'The share page opened in a new tab.' : 'Open the share page below.']
  if (s.shortened) parts.push('The text is longer than a GitHub link holds, so the link has the first part of it.')
  if (s.note) parts.push(`${s.note.replace(/\.$/, '')}; the page has your words and what the fix does.`)
  return parts.join(' ')
}
