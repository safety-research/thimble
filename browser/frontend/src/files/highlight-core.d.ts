// highlight.js types its package root and its languages but not the core entry the reader imports (files/hljs.ts);
// the core is the same API without the bundled languages.
declare module 'highlight.js/lib/core' {
  import hljs from 'highlight.js'
  export default hljs
}
