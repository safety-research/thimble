You are a text classifier. You judge records against one category and give each record one of the allowed values.

Category: {{name}}

Definition:
{{definition}}

Allowed values: {{labels}}

Each record is shown under a heading with its number and its id. Judge each record on its own, using only its text and the definition. Apply the definition as written, without widening or narrowing it. When the text does not settle the value, choose the value the text best supports and give a low confidence.

For each record, give its number as `i`, the value as `label`, and `confidence`: your probability, from 0 to 1, that the value is correct. {{comment}}

{{examples}}

Return exactly one entry for each record.
## comment

For each record, also give `rationale`: one short sentence naming the words in the record that decided the value.

## no-definition

(no definition was given)

## examples

These items have already been given their values. Read them as the standard for the category and give an item like one of them the same value.

## example

### example {{n}} [{{ref}}]
{{text}}
It was given the value {{value}}.

## example-note

A note on it reads {{note}}

## draft

The analyst described a label in their own words, and thimble applies the label you define at once, over the records of files, the cards or the report's sentences. Define it with the classifier that decides the description most exactly and most cheaply.

- A regex fits when a pattern in the text settles the value, such as a word, a field's value or a link. Python's re searches each record's line as the file holds it, so a JSON line is matched with its keys and quotes, and a row of a database or a CSV file as one `column: value` line per column. A unit that matches takes the first value and any other the second. Start the pattern with (?i) to ignore case.
- Code fits when a field, a count or a comparison settles the value. Define `label(unit)` in Python returning (value, confidence), where a JSON lines record is its dict, a line of text is {"text": the line}, a row of a database or a CSV file is a dict of its columns, a record of a JSON document is its value, a page of a PDF is {"page", "text"}, and a card is a dict with its text, kind, question, takeaway, group and groups.
- A prompt fits only when the value takes reading for meaning. A model then reads every unit against your definition, which is slow, so write the definition as one or two sentences that two careful readers would apply the same way.

Give two or a few short values, the positive first and the negative last, such as "match" and "no match". Name the label in a few words taken from the description. Label the records of files unless the description is about cards or report sentences. For records, mark span when the value rests on some words of the record, record when it rests on the whole record, and file when it rests on the whole file.

The analyst asked for: {{description}}

{{records}}

## records

The label would apply to {{paths}}. The first records of {{path}}, each cut at {{cut}} characters:

{{lines}}
