// A view proposal (backend views.offer: after a turn, a side thread's answer or the orientation's end, or a viewer for
// the type of a file opened in Files), as one card above the chat's composer in the accent, in the words of the
// terminal's row (plugin/hooks/term/band.tsx OFFER_LEAD, offerActs; bug hunt round 9, friction 7): "thimble can build
// a page for these records:", the view's name in bold and what it shows (for a file-type viewer, then the files it
// reads), then Build it, which builds it as a view the analyst asked for, Don't build it, and a quiet Stop suggesting
// pages, which turns view proposals off (Settings turns them on again). The oldest open proposal shows (openOffer); a
// `suggested` row without
// `offered` is from an older version and never shows, nor does one dismissed in the terminal in this session (`hidden`),
// and nothing shows while view proposals are off. A new proposal
// ignores clicks for ARM_MS, so a double click never answers it unread. A Build it that cannot start a build now keeps
// the proposal and says why, and what to do, under its buttons. The card never takes the focus, and a request that
// fails says so in a toast.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { invalidateSettings, loadSettings, onSettingsChange } from '../lib/models'
import { refreshProposals, useProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { Proposal } from '../lib/types'
import { ARM_MS } from './PermissionCard'

/** The card's head: what the analyst gets, as the terminal's row says it (band.tsx OFFER_LEAD). */
export const PROPOSAL_HEAD = 'thimble can build a page for these records:'
/** The card's buttons, in the terminal's words (band.tsx offerActs): build, don't build, and turn view proposals off. */
export const PROPOSAL_ACTS = { accept: 'Build it', reject: "Don't build it", off: 'Stop suggesting pages' } as const
/** The toast after Stop suggesting pages (and a notice's Turn off view proposals). */
export const PROPOSALS_OFF_LINE = 'thimble will suggest no more pages. Settings turns suggestions back on.'

/** The proposal the card shows: the oldest `suggested` row with `offered` whose view is not switched off and that the
 * terminal did not dismiss in this session. Pure. */
export function openOffer(proposals: readonly Proposal[] | null | undefined): Proposal | null {
  if (!Array.isArray(proposals)) return null
  const open = proposals.filter((p) => p.status === 'suggested' && !!p.offered && !p.off && !p.hidden)
  const at = (p: Proposal) => p.offered?.at ?? ''
  return open.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0))[0] ?? null
}

/** The line under the name: for a viewer of a file type (no task), the files it reads; none for a proposal with a
 * task, which the card does not show. Pure. */
export function offerFor(p: Pick<Proposal, 'task' | 'claims'>): string {
  if (p.task?.trim()) return ''
  const claims = (p.claims ?? []).filter(Boolean)
  return claims.length ? `For ${claims.join(', ')}` : ''
}

/** Whether view proposals are on (Settings, thimble's config `views.propose`): null until the settings are read, on
 * when they cannot be. */
export function useProposeViews(ws: string): boolean | null {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      loadSettings(ws)
        .then((s) => alive && setOn(s.propose_views !== false))
        .catch(() => alive && setOn(true))
    void read()
    const off = onSettingsChange((w) => w === ws && void read())
    return () => {
      alive = false
      off()
    }
  }, [ws])
  return on
}

/** Turn view proposals off (Stop suggesting pages, a notice's Turn off view proposals): the setting saved, every reader of
 * the settings told, and a toast that says where to turn them on again. */
export function proposalsOff(ws: string): Promise<void> {
  track('chat-settings', { target: 'ui:propose-views', detail: { propose_views: false } })
  return api.putSettings(ws, { propose_views: false }).then(() => {
    invalidateSettings(ws)
    bus.emit('toast', { text: PROPOSALS_OFF_LINE })
  })
}

/** A failed request's words without the status code the API puts first. */
const why = (e: Error) => e.message.replace(/^\d{3}\s+/, '')

export function ProposalCard({ ws }: { ws: string }) {
  const proposals = useProposals(ws)
  const on = useProposeViews(ws)
  // proposals answered here: Don't build it hides its proposal at once, and a failure shows it again
  const [gone, setGone] = useState<readonly string[]>([])
  const offer = on ? openOffer(proposals?.filter((p) => !gone.includes(p.slug))) : null
  const slug = offer?.slug ?? null
  // the proposal whose buttons take clicks, ARM_MS after it showed
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (!slug) return
    const t = window.setTimeout(() => setArmed(slug), ARM_MS)
    return () => window.clearTimeout(t)
  }, [slug])
  const [busy, setBusy] = useState<'accept' | 'reject' | 'off' | null>(null)
  // why this tab's Build it could not start the build, for the proposal it answered
  const [refused, setRefused] = useState<{ slug: string; reason: string } | null>(null)
  if (!offer) return null
  const p = offer
  const ready = armed === p.slug && !busy
  const accept = () => {
    if (!ready) return
    track('view-build', { target: `view:${p.slug}`, detail: { offer: true } })
    setBusy('accept')
    setRefused(null)
    api
      .acceptProposal(ws, p.slug)
      .then((row) => {
        // a start that cannot happen keeps the proposal open with the refusal (backend views.click_refused)
        if (row?.status === 'suggested' && row.refused) setRefused({ slug: p.slug, reason: row.refused.reason || 'The build could not start.' })
        return refreshProposals(ws)
      })
      .catch((e: Error) => bus.emit('toast', { text: `Could not build ${p.name}. ${why(e)}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const reject = () => {
    if (!ready) return
    track('view-dismiss', { target: `view:${p.slug}`, detail: { offer: true } })
    setBusy('reject')
    setGone((g) => [...g, p.slug])
    api
      .rejectProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => {
        setGone((g) => g.filter((s) => s !== p.slug))
        bus.emit('toast', { text: `Could not reject ${p.name}. ${why(e)}`, kind: 'error' })
      })
      .finally(() => setBusy(null))
  }
  const off = () => {
    if (!ready) return
    setBusy('off')
    proposalsOff(ws)
      .catch((e: Error) => bus.emit('toast', { text: `Could not turn view proposals off. ${why(e)}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const gate = { 'aria-disabled': !ready || undefined }
  // this tab's refusal, else the one the row keeps from an earlier Build it
  const reason = refused?.slug === p.slug ? refused.reason : p.refused?.reason || null
  const line = offerFor(p)
  const files = (p.claims ?? []).filter(Boolean)
  return (
    <div className="chat-offer" role="region" aria-label={PROPOSAL_HEAD.replace(/:$/, '')} data-slug={p.slug} data-after={p.offered?.after} data-armed={armed === p.slug || undefined}>
      <div className="chat-offer-head">
        <Icon name="sparkle" size={13} className="chat-offer-ico" />
        <span>{PROPOSAL_HEAD}</span>
      </div>
      <p className="chat-offer-text" title={files.length ? `Files: ${files.join(', ')}` : undefined}>
        <b className="chat-offer-name">{p.name}</b>
        {p.description && <span className="chat-offer-desc">{` ${p.description}`}</span>}
      </p>
      {line && <p className="chat-offer-files">{line}</p>}
      <div className="chat-offer-acts">
        <Button variant="primary" size="sm" className="chat-offer-accept" busy={busy === 'accept'} {...gate} onClick={accept}>
          {PROPOSAL_ACTS.accept}
        </Button>
        <Button variant="secondary" size="sm" className="chat-offer-reject" {...gate} onClick={reject}>
          {PROPOSAL_ACTS.reject}
        </Button>
        <button type="button" className="chat-offer-off" {...gate} onClick={off}>
          {PROPOSAL_ACTS.off}
        </button>
      </div>
      {reason && (
        <p className="chat-offer-refused" role="status">
          {reason}
        </p>
      )}
    </div>
  )
}
