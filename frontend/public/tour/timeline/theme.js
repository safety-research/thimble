// The example view's page takes the workbench's own look: its theme attributes and its stylesheets, copied from the page
// that frames it (the tour, same origin).
;(() => {
  try {
    const top = window.parent.document
    for (const a of ['data-paper', 'data-accent', 'data-theme']) {
      const v = top.documentElement.getAttribute(a)
      if (v) document.documentElement.setAttribute(a, v)
    }
    for (const el of top.querySelectorAll('link[rel="stylesheet"], style')) document.head.append(el.cloneNode(true))
  } catch {
    // opened on its own: the page draws without the workbench's styles
  }
})()
