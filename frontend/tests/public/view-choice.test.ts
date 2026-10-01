import { describe, expect, it } from 'vitest'
import { openInItems } from '../../src/files/OpenIn'
import { chooseView } from '../../src/files/viewChoice'
import { claimMatches } from '../../src/files/labels'

const views = [{ slug: 'threads', name: 'Threads' }, { slug: 'timeline', name: 'Timeline' }]

describe('chooseView', () => {
  it('opens a file in the view a ref names, else the one last used for it, else the File browser', () => {
    expect(chooseView({ views, asked: 'timeline', remembered: 'threads' })).toBe('timeline')
    expect(chooseView({ views, remembered: 'threads' })).toBe('threads')
    expect(chooseView({ views, remembered: 'gone' })).toBeNull()
    expect(chooseView({ views })).toBeNull()
  })
})

describe('openInItems', () => {
  it('lists the other views, and the File browser from a view', () => {
    const none = () => undefined
    expect(openInItems(views, 'threads', none).map((i) => ('label' in i ? i.label : i.id))).toEqual(['Timeline', 'File browser'])
    expect(openInItems(views, null, none).map((i) => ('label' in i ? i.label : i.id))).toEqual(['Threads', 'Timeline'])
  })
})

describe('claimMatches', () => {
  it('lets a ** folder stand for no folder, as the server does', () => {
    expect(claimMatches('talk.vtt', '**/*.vtt')).toBe(true)
    expect(claimMatches('a/b/talk.vtt', '**/*.vtt')).toBe(true)
    expect(claimMatches('runs/events.jsonl', 'runs/**/events.jsonl')).toBe(true)
    expect(claimMatches('runs/r1/events.jsonl', 'runs/**/events.jsonl')).toBe(true)
    expect(claimMatches('other/events.jsonl', 'runs/**/events.jsonl')).toBe(false)
    expect(claimMatches('talk.srt', '**/*.vtt')).toBe(false)
  })
})
