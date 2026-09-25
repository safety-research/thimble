// Which view opens a file: the analyst's last choice for that file, else the view a ref names (view:<slug>/<key>, or a
// view opened from the views row), else the first view that claims the file and accepts the ref's fragment in the
// server's order (the default view first, then the one built last), else the built-in file views. Pure, so the choice
// is tested without a page.
import type { View } from '../lib/types'

/** The switcher's value for a written view; a built-in file view is its type (raw, table, text, transcript, forge). */
export const viewValue = (slug: string): string => `v:${slug}`
export const slugOf = (value: string | null | undefined): string | null => (value && value.startsWith('v:') ? value.slice(2) : null)

const NUMERIC = new Set(['n', 'm', 'k', 'i', 'j', 'line', 'page', 'p', 'row', 'rev', 'seq'])

/** A form such as `L<n>` or `<Sheet>!<A1>` as a regex over a fragment (backend views.form_regex keeps the same rule). */
export function formRegex(form: string): RegExp {
  let out = ''
  let pos = 0
  for (const m of form.matchAll(/<([^<>]+)>/g)) {
    out += escape(form.slice(pos, m.index))
    out += NUMERIC.has(m[1].trim().toLowerCase()) ? '\\d+' : '.+?'
    pos = (m.index ?? 0) + m[0].length
  }
  out += escape(form.slice(pos))
  return new RegExp(`^${out}$`)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function accepts(view: Pick<View, 'accepts'>, fragment: string): boolean {
  return view.accepts.some((f) => formRegex(f.form).test(fragment))
}

export interface ChoiceInput {
  /** the working views that claim the file, in the server's order */
  views: Pick<View, 'slug' | 'accepts'>[]
  /** the fragment of the ref the file was opened at, when it points into this file */
  fragment: string | null
  /** the view a view ref or the views row asked for */
  asked?: string | null
  /** the analyst's last choice for this file (a switcher value) */
  remembered?: string | null
}

/** The switcher value to open with, or null for the built-in views' own pick. */
export function chooseView({ views, fragment, asked, remembered }: ChoiceInput): string | null {
  const known = (slug: string | null) => (slug ? views.find((v) => v.slug === slug) : undefined)
  const askedView = known(asked ?? null)
  if (askedView) return viewValue(askedView.slug)
  if (remembered) {
    const rv = known(slugOf(remembered))
    if (rv && (fragment == null || accepts(rv, fragment))) return viewValue(rv.slug)
    if (!slugOf(remembered)) return remembered
  }
  const fit = fragment == null ? views[0] : views.find((v) => accepts(v, fragment))
  return fit ? viewValue(fit.slug) : null
}

/**
 * Where a file ref with a fragment opens among the views: the first view, in the server's order, that accepts the
 * fragment and whose reader knows the place (`knows`); else, for a span or a block (`L12.b0:c3-9`), the first view that
 * knows the record it sits in (`L12`), opened at the record; else null for the File browser.
 */
export async function viewPlace(
  views: Pick<View, 'slug' | 'accepts'>[],
  path: string,
  fragment: string,
  knows: (slug: string, ref: string) => Promise<boolean>,
): Promise<{ slug: string; ref: string } | null> {
  const record = /^L\d+(?=[.:])/.exec(fragment)?.[0]
  for (const frag of record ? [fragment, record] : [fragment]) {
    const ref = `${path}#${frag}`
    for (const v of views) {
      if (accepts(v, frag) && (await knows(v.slug, ref))) return { slug: v.slug, ref }
    }
  }
  return null
}
