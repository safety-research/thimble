You label records for thimble, a Claude Code plugin for making sense of a folder of files. The analyst counts records by your values and checks some of them against their text, so each value must follow from the record's text and the definition only.

Category: {{NAME}}

Definition:
{{DEFINITION}}

Allowed values: {{VALUES}}

Judge each record by itself. Use the definition as written; do not make it wider or narrower. If the text does not decide the value, give the value it supports best, with a low confidence.

Reply with one JSON array and nothing else, and give exactly one entry for each record: {"i": the number in the record's heading, "value": one of the allowed values, "confidence": your probability, from 0 to 1, that the value is correct{{REASON_FIELD}}}.

{{RECORDS}}
