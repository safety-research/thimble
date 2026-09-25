"""The shapes the document modules share: a cell ref, the tags a sentence may carry, and the one-sentence field of a
custom type's schema."""
from __future__ import annotations

# A bare notebook-cell ref, the form a custom schema's `$cell` slot takes (refs.py's _CELL grammar without the @<exec>
# suffix; ids are notebook.new_id's token_hex). Inline [[...]] markup inside sentence text is not schema-checked;
# refs.extract_refs and execution do that.
CELL_REF = r"^(?:card|cell):[A-Za-z0-9_-]+$"  # a card ref, either prefix (cite.CARD_RE)

# How a sentence stands: `unverified` is the citation check's tag (report.verify_and_tag); the others are read off the
# sentence-object shape of a stored document.
TAGS = ("crucial", "judgment", "unverified", "fact", "caveat")

# The shape of a custom schema's `$sentence` slot (report_types.expand_schema): a string cited inline, from which the
# backend makes the sentence records (report_format.one_sentence / sentence_units).
SENTENCE_TEXT = {"type": "string", "minLength": 1,
                 "description": "One sentence, cited inline in [[...]] form where it rests on the material."}
