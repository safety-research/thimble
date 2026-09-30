import { describe, expect, it } from 'vitest'
import { openInItems } from '../../src/files/OpenIn'
import { chooseView } from '../../src/files/viewChoice'

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
