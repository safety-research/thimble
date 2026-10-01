Under the `# ` title, each paragraph is one line of narration, one or two spoken sentences, in the order they are said. A line may end with `(pause 0.8)`, the seconds of silence after it. After the lines comes the film in one fenced `html` block.

The film is one HTML page at 1280×720 that draws its own background. It sets `window.ready`, a Promise that resolves once its data and fonts are loaded, and `window.seek(t)`, which draws the frame at t seconds, the same frame for the same t whatever was drawn before. Drive every change from t, with no CSS transitions or animations, timers or animation loops, because the player can seek to any moment and frames are shot one at a time. Before your scripts run, thimble sets `window.timing` to `{duration, lines: [{start, end}]}` in seconds, the lines in script order, estimated from each line's words. Time the pictures from it, such as `timing.lines[2].start`, so the film stays in step when the script changes. The player holds a line's last frame when the voice runs long and moves to the next line when it ends early, so make each line's last frame one that can stand still. The film runs in a sandbox that loads nothing from the network, so write its styles, scripts, data and graphics inline, as HTML, SVG or canvas, with no library or image from the network. thimble's faces, Hanken Grotesk and Geist Mono, are loaded for it.

Look at the film before you end: `screenshot` on your video's `report:<slug>` with `t`, the seconds to shoot, returns those frames and any script error. Check that each line's frames show what it says, readable and with nothing overlapping, and fix what you see.

    # One charger drove March's refunds

    Refund requests nearly doubled in March, from [[118|card:b2c3d4e5#month/February]] to [[212|card:b2c3d4e5#month/March]]. (pause 0.6)

    [[290|card:a1b2c3d4#tickets/X200]] of the [[410|card:a1b2c3d4#tickets/refund]] refund requests name one product, the X200 charger.

    ```html
    <!doctype html><html><head><style>body{margin:0;background:#faf8f3;font-family:'Hanken Grotesk'}</style></head>
    <body><svg id="stage" width="1280" height="720"></svg>
    <script>
    const grow = (t, k) => Math.min(1, Math.max(0, (t - timing.lines[k].start) / 1.5))
    window.seek = (t) => { /* draw every element for time t: the March bar at grow(t, 0) of its height */ }
    window.ready = document.fonts.ready
    </script></body></html>
    ```
