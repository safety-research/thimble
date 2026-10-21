# thimble browser's tools: fix thimble

Each `## <tool>` section is one tool Claude gets. These tools work in a fix's copy of thimble's code and nowhere else
(server/thimble_browser/fixcopy.py): a path outside the copy is refused.

## fix_start

Make a copy of thimble's code to change, outside the analyst's folder. The result gives the fix's slug, which the other fix tools take.

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string", "description": "What the change does, in a few words, such as \"Sort claims newest first\"."}
  },
  "required": ["title"]
}
```

## fix_files

List the files under a folder of the fix's copy.

```json
{
  "type": "object",
  "properties": {
    "slug": {"type": "string"},
    "dir": {"type": "string", "description": "A folder of the copy, such as plugin/claims. Default: the copy's top."}
  },
  "required": ["slug"]
}
```

## fix_read

Read one file of the fix's copy, with line numbers.

```json
{
  "type": "object",
  "properties": {
    "slug": {"type": "string"},
    "path": {"type": "string", "description": "The file's path in the copy, such as plugin/claims/list.js."},
    "offset": {"type": "integer", "description": "The first line to read."}
  },
  "required": ["slug", "path"]
}
```

## fix_edit

Change one file of the fix's copy: replace `old`, which must be found once, with `new`. With no `old`, write `new` as the whole file.

```json
{
  "type": "object",
  "properties": {
    "slug": {"type": "string"},
    "path": {"type": "string"},
    "old": {"type": "string"},
    "new": {"type": "string"}
  },
  "required": ["slug", "path", "new"]
}
```

## fix_test

Run thimble's tests in the fix's copy (pytest), in a sandbox that can read the copy and not change it. Give the test file or folder that the change concerns.

```json
{
  "type": "object",
  "properties": {
    "slug": {"type": "string"},
    "path": {"type": "string", "description": "A test file or folder of the copy, such as plugin/tests/test_fix.py. Default: plugin."},
    "args": {"type": "array", "items": {"type": "string"}, "description": "pytest's own flags, such as -x or -k NAME."}
  },
  "required": ["slug"]
}
```

## fix_use

Turn the fix's copy on in the analyst's thimble, so they can try the change. The result says how it takes effect.

```json
{
  "type": "object",
  "properties": {
    "slug": {"type": "string"}
  },
  "required": ["slug"]
}
```

## fix_undo

Turn the fix off: the analyst's thimble goes back to the release.

```json
{
  "type": "object",
  "properties": {}
}
```
