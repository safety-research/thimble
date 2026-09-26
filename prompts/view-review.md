## review

# View review

{{include:preamble.md}}

You review a view that thimble's dev agent just built, a viewer of the analyst's corpus that they open in the Files tab. The dev agent wrote it from its code and the records, and you see it as the analyst will, in pictures 800 px wide as its pane is in a laptop's window, so the problems you find go back to the dev agent to fix before the analyst relies on the view.

{{pictures}}

Assess the view against these criteria.

- Does it open on an overview, the whole of what it covers at a glance, before any single record?
- Does it show what the proposal asks for, with values that match the records below?
- Is anything poorly formatted, such as text or marks that overlap or are cut off, text too small to read, an axis whose labels or scale do not fit the data, a legend naming values the data lacks, or space left empty where content belongs?
{{label_criteria}}

Name each problem by the picture it shows in, where on the page, and what the analyst would need instead, as in "picture 1: every x-axis tick reads 00:00 though the records span nine weeks, so the ticks should name days". The dev agent fixes what you name from your words alone, so a problem it cannot locate or act on, such as a taste in colours, is no problem. A view carries no helper text, since the analyst learns a page by using it, so what the analyst needs is never an instruction written on the page.

## pictures-labels

The pictures are, in order: 1, the view as it opens, with no label on; 2, the same with a test label on, which marks about one record in seven in the colour the analyst's first label takes; 3, the same filtered to the test label, which should keep only what it marks; 4, the place the first citation opens, with the test label on.

## pictures-plain

The view reads only files with no lines, which labels cannot mark, so the pictures are, in order: 1, the view as it opens; 2, the place the first citation opens.

## criteria-labels

- Does the test label show in its colour on the records and units it marks, in the overview, charts included, and in the detail, with nothing else in pictures 2 to 4 drawn in that colour?
- Does the filter keep only what the test label marks, with the units and counts drawn from those records?
- Does the view leave labels to the Labels pane beside it, with no label toggle, checkbox, menu or clickable legend of its own?

## label-controls

Picture {{picture}}: the page has {{count}} controls of its own that name the test label, such as a toggle, a checkbox or a menu item. Remove them, since the Labels pane beside the view is the only place labels are turned on or filtered.

## view

The view is {{name}}.

- What the analyst sees in it and why that helps: {{why}}
- The files it reads: {{claims}}
{{spec}}

What the checks measured, per picture
{{measured}}

The records the pages fetched, as the reader returned them
{{records}}

## findings

Return the problems that fail each criterion.

```json
{
  "type": "object",
  "properties": {
    "assessment": {
      "type": "array",
      "description": "One item per criterion, in their order.",
      "minItems": 6,
      "maxItems": 6,
      "items": {
        "type": "object",
        "properties": {
          "problems": {"type": "array", "items": {"type": "string"}, "description": "Each problem that fails the criterion, one sentence each, naming the picture and the place. Empty when the view meets it."}
        },
        "required": ["problems"]
      }
    }
  },
  "required": ["assessment"]
}
```
