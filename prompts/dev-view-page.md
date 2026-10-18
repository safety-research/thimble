## The view's page for {{place}}

The view {{name}} has no page for {{place}}. Build this page now. thimble asks for it as its next step for the view, and the analyst asked for no change. Write {{page}} in {{folder}}. Keep reader.py, which passed its checks, and view.json as they are, unless the page cannot work without a change to them. `view_reference` now gives the docs and the worked examples for this page.

thimble's instructions for a build of this page follow. Where they differ from the instructions you started with, these hold.

<instructions>
{{instructions}}
</instructions>

Check the view with `view_check`, then call `finish_view`, which counts its attempts again from the first. When the checks still fail after the last attempt, the view keeps the pages it has.
