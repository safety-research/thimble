// The top bar's indicator of thimble's own work (lib/busy.ts): the stream's `busy` records start and end jobs; a job
// shows after 300 ms, the newest first, with its seconds from 3 s on, and a dropped stream clears them.
import { describe, expect, it } from 'vitest'
import { bus } from '../../src/lib/bus'
import { busyNow, busyRecord } from '../../src/lib/busy'

describe('busy', () => {
  it('shows the newest job once it has run 300 ms, with seconds from 3 s, and nothing once all ended', () => {
    const t = Date.now()
    busyRecord('a', 'marking', true)
    expect(busyNow(t + 100)).toBeNull()
    expect(busyNow(t + 400)).toEqual({ word: 'marking', secs: null })
    expect(busyNow(t + 4200)).toEqual({ word: 'marking', secs: 4 })
    busyRecord('b', 'labeling', true)
    expect(busyNow(Date.now() + 500)?.word).toBe('labeling')
    busyRecord('b', 'labeling', false)
    expect(busyNow(Date.now() + 500)?.word).toBe('marking')
    busyRecord('a', 'marking', false)
    expect(busyNow(Date.now() + 5000)).toBeNull()
  })

  it('shows a document Claude writes from generating until its next status', () => {
    bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'generating' } as never)
    expect(busyNow(Date.now() + 500)?.word).toBe('writing')
    bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'generated' } as never)
    expect(busyNow(Date.now() + 500)).toBeNull()
  })

  it('clears its jobs when the stream drops', () => {
    busyRecord('c', 'marking', true)
    bus.emit('wsStream', { connected: false })
    expect(busyNow(Date.now() + 5000)).toBeNull()
  })
})
