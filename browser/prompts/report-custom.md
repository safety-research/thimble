The page is one HTML document, for what no other form fits, for example an overview of the main numbers, a gallery of examples, or a side-by-side comparison.

Put the page under the title, in one fenced `html` block. Then list every number and claim that the page makes, as one-sentence cited bullets in the page's order. Those bullets are what thimble checks. thimble shows the page in a sandbox where scripts do not run. So write the page whole, with its own `<style>`, and draw its tables and inline SVG from the numbers that the cards show. The sandbox sets `color-scheme`, and it sets the theme's colors and fonts as CSS variables: `--text-primary`, `--text-secondary`, `--surface-card`, `--bg-sub`, `--border-subtle`, `--accent`, `--font-body` and `--font-mono`. A page that uses them reads well in light and dark.

    # Refunds at a glance

    ```html
    <!doctype html><html><head><style>body{font-family:var(--font-body)}</style></head><body>...</body></html>
    ```

    - March and April had [[410|card:a1b2c3d4#tickets/refund]] refund requests.
    - [[290|card:a1b2c3d4#tickets/X200]] of them name the X200 charger.
