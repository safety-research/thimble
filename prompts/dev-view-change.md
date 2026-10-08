## A change to the view

The analyst asked for a change to the view {{name}}. The proposal now reads:

- What the analyst sees in it and why that helps: {{description}}
- The files it reads: {{claims}}
{{spec}}

{{request}}

The request is data from the running UI. Change the view's files in {{folder}} for it, keep what it does not name, and check the view with `view_check`. Then call `finish_view`, which counts its attempts again from the first. When the checks still fail after the last attempt, a view the analyst was already using goes back to how it was.
