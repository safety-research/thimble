// Stand-in for the panel lane's notices.tsx (SPEC-v2 3.20): a failure notice with the acts that fix it, and one toast.
import type { Ctx } from './ctx'

/** Posts the notice `key` (a band row once the panel lane builds it) and one toast with its text. */
export function postNotice(cx: Ctx, key: string, text: string, acts: string[]): void {
  void key
  void acts
  cx.toast(text)
}
