// The busy line's record of thimble's own work (lib/busy.ts): the stream's `busy` records and the page's own jobs start
// and end steps; a step shows after 300 ms, the newest first with "+1" for each other step, its seconds from 3 s on, and
// a dropped stream clears the stream's steps but not the page's own (a restart drops the stream).
import { describe, expect, it } from 'vitest'
import { bus } from '../../src/lib/bus'
import { busyNow, busyRecord, busySteps, pageJob } from '../../src/lib/busy'

describe('busy', () => {
  it('names the step running now, the newest first with +1 for another, and nothing once all ended', () => {
    const t = Date.now()
    busyRecord('a', 'adding explainers, details', true)
    expect(busyNow(t + 100)).toBeNull()
    expect(busyNow(t + 400)).toEqual({ word: 'adding explainers, details', secs: null })
    expect(busyNow(t + 4200)).toEqual({ word: 'adding explainers, details', secs: 4 })
    busyRecord('b', 'labeling: tone', true)
    expect(busyNow(Date.now() + 500)?.word).toBe('labeling: tone +1')
    expect(busySteps()).toEqual(['adding explainers, details', 'labeling: tone'])
    busyRecord('b', 'labeling: tone', false)
    expect(busyNow(Date.now() + 500)?.word).toBe('adding explainers, details')
    busyRecord('a', 'adding explainers, details', false)
    expect(busyNow(Date.now() + 5000)).toBeNull()
  })

  it('shows a document Claude writes from generating until its next status', () => {
    bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'generating' } as never)
    expect(busyNow(Date.now() + 500)?.word).toBe('writing the report')
    bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'generated' } as never)
    expect(busyNow(Date.now() + 500)).toBeNull()
  })

  it("clears the stream's steps when it drops, and keeps the page's own", () => {
    busyRecord('c', 'adding explainers, details', true)
    pageJob('fix:restart', 'restarting with the fix')
    bus.emit('wsStream', { connected: false })
    expect(busySteps()).toEqual(['restarting with the fix'])
    pageJob('fix:restart', null)
    expect(busyNow(Date.now() + 5000)).toBeNull()
  })
})
