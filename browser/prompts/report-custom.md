The page is one HTML document, for what no other form fits, such as an overview of the main numbers, a gallery of examples or a side-by-side comparison. When the type has its own text, it is above this paragraph and says what the page is for. The page is shown in a sandbox where scripts do not run, so write it whole, with its own `<style>`, and draw its tables and inline SVG from the numbers the cards show. The sandbox sets `color-scheme` and the theme's colors as CSS variables, `--text-primary`, `--text-secondary`, `--surface-card`, `--bg-sub`, `--border-subtle`, `--accent`, `--font-body` and `--font-mono`, so a page that uses them reads well in light and dark. Under the title comes the page in one fenced `html` block, then every number and claim it makes as one-sentence cited bullets, in the page's order, because those bullets are what gets checked.

    # Refunds at a glance

    ```html
    <!doctype html><html><head><style>body{font-family:var(--font-body)}</style></head><body>...</body></html>
    ```

    - March and April had [[410|card:a1b2c3d4#tickets/refund]] refund requests.
    - [[290|card:a1b2c3d4#tickets/X200]] of them name the X200 charger.
