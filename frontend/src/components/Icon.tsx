// Inline SVG icons: every glyph is hand-drawn in a 24x24 box, stroke 1.75, round caps and joins, no fill, except the
// filled silhouettes (FILLED). Dots are zero-length round-capped segments so they scale with the stroke.
// Three glyphs are copied, and their license needs the notice below in every copy, the built UI included; a comment
// that opens with /*! is one the production build keeps.
/*! The gear and branch glyphs follow the settings and git-branch icons of Feather, Copyright (c) 2013-2023 Cole
 * Bemis; the edit glyph follows the pencil icon of Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. Both under the
 * MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The
 * above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE. */
import type { SVGProps } from 'react'

export type IconName =
  | 'thimble'
  | 'files'
  | 'chat'
  | 'chat-back'
  | 'reader'
  | 'notebook'
  | 'report'
  | 'writeup'
  | 'question'
  | 'warning'
  | 'globe'
  | 'plus'
  | 'minus'
  | 'reset'
  | 'comment'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevron-up'
  | 'pin'
  | 'x'
  | 'folder'
  | 'folder-open'
  | 'agent'
  | 'board'
  | 'events'
  | 'forge'
  | 'prompt'
  | 'text'
  | 'run'
  | 'expand'
  | 'collapse'
  | 'search'
  | 'code'
  | 'tag'
  | 'history'
  | 'arrow-up'
  | 'trash'
  | 'stop'
  | 'link'
  | 'person'
  | 'arrow-left'
  | 'arrow-right'
  | 'graph'
  | 'check'
  | 'flag'
  | 'download'
  | 'more-horizontal'
  | 'refresh'
  | 'reply'
  | 'arrow-up-right'
  | 'terminal'
  | 'file'
  | 'edit'
  | 'todo'
  | 'gear'
  | 'branch'
  | 'panel-left'
  | 'panel-right'
  | 'bolt'
  | 'undo'
  | 'redo'
  | 'hammer'
  | 'canvas'
  | 'command'
  | 'sun'
  | 'moon'
  | 'bug'
  | 'clock'
  | 'cell'
  | 'group'
  | 'thread'
  | 'label'
  | 'view'
  | 'cite'
  | 'palette'
  | 'link-off'
  | 'archive'
  | 'star'
  | 'lock'
  | 'unlock'
  | 'ask'
  | 'cell-add'
  | 'braces'
  | 'doc'
  | 'table'
  | 'pulse'
  | 'sparkle'
  | 'regex'
  | 'span'
  | 'lines'
  | 'heading'
  | 'letter'
  | 'subheading'
  | 'bullets'
  | 'numbers'
  | 'sidebar'
  | 'page'
  | 'sliders'
  | 'image'
  | 'markdown'
  | 'pause'
  | 'exclaim'
  | 'card-right'
  | 'card-left'
  | 'card-full'
  | 'card-none'

const BUBBLE = 'M12 3a8.5 8.5 0 0 1 0 17c-1.6 0-3.1-.45-4.4-1.2L3.5 20l1.2-4.1A8.5 8.5 0 0 1 12 3z'

const PATHS: Record<IconName, string> = {
  thimble: 'M5 17L6 8a6 6 0 0 1 12 0l1 9' + 'M4 17h16a2 2 0 0 1 0 4H4a2 2 0 0 1 0-4z' + 'M12 5.2h.01M9.3 8.3h.01M14.7 8.3h.01M8.1 11.4h.01M12 11.4h.01M15.9 11.4h.01M9.5 14.4h.01M14.5 14.4h.01',
  // the Files surface: a folder, in the canvas's and the report's box (4 to 20 across)
  files: 'M4 7.5a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
  chat: BUBBLE + 'M8 11.5h.01M12 11.5h.01M16 11.5h.01',
  'chat-back': BUBBLE + 'M16 11.5H8M11 8.5l-3 3 3 3',
  reader: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  notebook: 'M6 3h12a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 18 21H6a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 6 3z' + 'M8.5 3v18M11.5 8.5h4M11.5 12.5h4',
  report: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' + 'M8.5 7.5h4M8.5 12h7M8.5 16.5h7',
  writeup: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4.5' + 'M14 3v5h5M19 8v2.5' + 'M9 12h5M9 16h3' + 'M21.1 13.4a1.6 1.6 0 0 1 0 2.3L15.4 21.4l-3.1.7.7-3.1 5.7-5.7a1.6 1.6 0 0 1 2.3 0z',
  question: 'M8.6 8.6a3.4 3.4 0 1 1 4.9 3.05c-1 .55-1.5 1.3-1.5 2.35v.8M12 19h.01',
  warning: 'M10.7 4.6a1.5 1.5 0 0 1 2.6 0l8.2 14.2a1.5 1.5 0 0 1-1.3 2.2H4.8a1.5 1.5 0 0 1-1.3-2.2zM12 9.5v4.5M12 17.2h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM3 12h18M12 3c-2.5 2.6-3.75 5.6-3.75 9s1.25 6.4 3.75 9c2.5-2.6 3.75-5.6 3.75-9S14.5 5.6 12 3z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  reset: 'M4 12a8 8 0 1 0 2.35-5.65L4 8.5M4 3.5v5h5',
  comment: BUBBLE + 'M8 9.5h8M8 13h5',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  pin: 'M9 3h6M10 3v5l-3 3h10l-3-3V3M12 11v10',
  x: 'M6 6l12 12M18 6L6 18',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-open': 'M3 18V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1' + 'M3 18l2.6-6.6a1.5 1.5 0 0 1 1.4-.9h14.5l-2.6 6.6a1.5 1.5 0 0 1-1.4.9z',
  agent: 'M5 9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM12 7V3.5M9 13h.01M15 13h.01M9.5 16.5h5',
  board: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 16v5M8 21h8M7 8h6M7 11.5h10',
  events: 'M3 12h4l3-7 4 14 3-7h4',
  forge: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12a8 3 0 0 0 16 0V6M4 12a8 3 0 0 0 16 0',
  prompt: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 12l2.5 2.5L9 17M13 17h3',
  text: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  run: 'M7 4.5v15l12-7.5z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  search: 'M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M15.2 15.2L20 20',
  code: 'M8.5 6.5L3 12l5.5 5.5M15.5 6.5L21 12l-5.5 5.5',
  tag: 'M3 5a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8l-6.4 6.4a2 2 0 0 1-2.8 0L3.6 12.6A2 2 0 0 1 3 11.2zM8 8h.01',
  history: 'M3.5 9a9 9 0 1 1-1 4.5M3.5 9V4M3.5 9h4.5M12 8v4.5l3 2',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  trash: 'M4 7h16M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1zM6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 11v6M14 11v6',
  stop: 'M8 7.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H8a.5.5 0 0 1-.5-.5V8a.5.5 0 0 1 .5-.5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  person: 'M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM5 20a7 7 0 0 1 14 0',
  'arrow-left': 'M19 12H5M11 5l-7 7 7 7',
  'arrow-right': 'M5 12h14M13 5l7 7-7 7',
  graph: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0' + 'M3 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0' + 'M17 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0' + 'M3 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0' + 'M17 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0' + 'M9.8 10.2L6.5 7.3M14.2 10.2l3.3-2.9M9.8 13.8l-3.3 2.9M14.2 13.8l3.3 2.9',
  check: 'M5 12.5l4.5 4.5L19 7',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  download: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  'more-horizontal': 'M6 12h.01M12 12h.01M18 12h.01',
  refresh: 'M20 12a8 8 0 1 1-2.35-5.65L20 8.5M20 3.5v5h-5',
  reply: 'M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-3',
  'arrow-up-right': 'M7 17L17 7M8 7h9v9',
  terminal: 'M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9l3 3-3 3M13 15h4',
  file: 'M8 3h6l5 5v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5',
  edit: 'M4 20h4L19 9a2 2 0 0 0-4-4L4 16v4zM13 7l4 4',
  todo: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  'panel-left': 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14',
  'panel-right': 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5v14',
  bolt: 'M13 2.5L4 14h8l-1 7.5L20 10h-8z',
  // an arrow back over a curve, and its mirror: the top bar's undo and redo
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  hammer: 'M14.66 12.45L16.25 14.04A1.8 1.8 0 0 0 18.79 14.04L20.84 11.99A1.8 1.8 0 0 0 20.84 9.45L14.55 3.16A1.8 1.8 0 0 0 12.01 3.16L9.96 5.21A1.8 1.8 0 0 0 9.96 7.75L11.55 9.34L3 18.74A1.6 1.6 0 0 0 5.26 21Z',
  // the canvas: four cards
  canvas: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  // the command key's loop
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  // the theme toggle
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  // the top bar's Report a problem: a beetle, its body split down the back, three legs a side
  bug: 'M8 10a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0zM9.5 6.3a2.5 2.5 0 0 1 5 0M10.3 4.4L8.8 2.9M13.7 4.4l1.5-1.5M12 11v7M8 12.5H4M16 12.5h4M8 9.5L5 8M16 9.5l3-1.5M8.2 15.5L5 17.5M15.8 15.5l3.2 2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 7.5V12l3.2 2',
  // what a chip can point to (cell, group, file, thread, label, view, report) and the citation: plain geometry that
  // reads at 10 px. file and report are the glyphs above
  cell: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 11h8',
  group: 'M4 8.5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8.5 6.5V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-1.5',
  thread: 'M6 3v12a3 3 0 0 0 3 3h11M16 14l4 4-4 4',
  label: 'M4 4h8l8 8-8 8-8-8zM8 8h.01',
  view: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 16v5M8 21h8',
  cite: 'M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6',
  // the top bar's theme popover and links toggle; an archive file (a zip) in Files
  palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2zM7.5 12h.01M9 7.8h.01M13.5 7h.01M17 10h.01',
  'link-off': 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1M3 3l18 18',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  // the analyst's lock on a card or a report block, closed while it holds and open while it does not
  lock: 'M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11zM8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11zM8 11V8a4 4 0 0 1 7.75-1.4',
  ask: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  'cell-add': 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 9v6M9 12h6',
  // the Files pane's glyphs: a JSON file, a text file, a table, an event stream, and the label edit card's marks (span,
  // record) and classifiers (prompt, regex)
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  regex: 'M16 3v8M12.5 5l7 4M19.5 5l-7 4M6 18a1.5 1.5 0 1 0 0 .01',
  span: 'M5 7V5h14v2M9 19h6M12 5v14',
  lines: 'M4 6h16M4 12h16M4 18h10',
  heading: 'M6 5v14M18 5v14M6 12h12',
  letter: 'M5 5h14M12 5v14',
  // the report block's kinds beside the heading and the letter: a smaller H, dotted lines, numbered lines
  subheading: 'M7 8v9M15 8v9M7 12.5h8',
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbers: 'M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4.5M4 14.5a1.5 1.5 0 0 1 3 0c0 1.2-3 2-3 3.5h3',
  sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14',
  // the Files tree's other kinds of file (files/Tree glyphOf), in the same hand: a bare page (a file of no known kind),
  // configuration (two sliders), a picture, and markdown (its mark, M and a down arrow); source code takes `code`
  page: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16.5l4.5-4.5 4 4 2.5-2.5 5 5M15.5 8.5h.01',
  markdown: 'M3.5 6h17a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 15V9l2.75 3L11.5 9v6M17 9v6M14.75 12.75L17 15l2.25-2.25',
  // the permission modes on Start's switcher (StartGate): Manual a pause, Auto the play triangle `run`, Bypass an
  // exclamation mark
  pause: 'M9 5.5v13M15 5.5v13',
  exclaim: 'M12 4.5v10M12 19.5h.01',
  // where a story section's card stands (the story editor's section bar), drawn as alignment glyphs are, the text as
  // lines and the card as a box: at the right of the text, at its left, across the page under it, and no card
  'card-right': 'M3 7h8M3 12h8M3 17h5M14.5 5h5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 14.5 5z',
  'card-left': 'M13 7h8M13 12h8M13 17h5M4.5 5h5A1.5 1.5 0 0 1 11 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5z',
  'card-full': 'M3 4h18M3 8h12M4.5 12h15a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-5A1.5 1.5 0 0 1 4.5 12z',
  'card-none': 'M3 7h18M3 12h18M3 17h12',
}

/** The glyphs drawn as a filled shape: the path takes currentColor as its fill and no stroke. */
export const FILLED: ReadonlySet<IconName> = new Set<IconName>(['hammer'])

/** The chip glyphs are drawn at stroke 2, the weight they hold at the 10 px a chip renders them. */
const STROKE: Partial<Record<IconName, number>> = { cell: 2, group: 2, thread: 2, label: 2, view: 2, cite: 2, file: 2, report: 2 }

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** rendered width and height in px (default 16) */
  size?: number
  /** accessible label; without one the icon is decorative */
  title?: string
}

export function Icon({ name, size = 16, title, className, ...rest }: IconProps) {
  const cls = className ? `icon icon-${name} ${className}` : `icon icon-${name}`
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={STROKE[name] ?? 1.75} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} {...rest}>
      {title && <title>{title}</title>}
      <path d={PATHS[name]} fill={FILLED.has(name) ? 'currentColor' : undefined} stroke={FILLED.has(name) ? 'none' : undefined} />
    </svg>
  )
}

export default Icon
