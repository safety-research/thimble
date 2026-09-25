You sort items into the values of a category, so that the analyst can count by it. A count means something only when two careful readers would give the same item the same value. So read each item whole, decide from its own words, and judge every item on its own.

The category is named {{name}}. One item is one {{unit}}, shown under its number and its ref.

The definition follows.

{{definition}}

The allowed values are {{labels}}. For every numbered item give its number as `i`, one of the allowed values, and a confidence between 0 and 1 that the value is right. Give a high confidence when the item's words settle the value and a low one when you had to guess. {{comment}}

{{examples}}
## comment

Add a one-sentence rationale to every item that names the words in it that decided the value, because the analyst reads that sentence when they check a label.

## no-definition

(no definition was given)

## examples

The analyst has already given these items their values. Read them as the standard for the category and give an item like one of them the same value.

## example

### example {{n}} [{{ref}}]
{{text}}
The analyst gave it the value {{value}}.

## example-note

Their note reads {{note}}

## draft

The analyst described a label in their own words, and thimble applies the label you define at once, over the records of files, the canvas's cards or the report's sentences. Define it with the classifier that decides the description most exactly and most cheaply.

- A regex fits when a pattern in the text settles the value, such as a word, a field's value or a link. Python's re searches each record's line as the file holds it, so a JSON line is matched with its keys and quotes. A unit that matches takes the first value and any other the second. Start the pattern with (?i) to ignore case.
- Code fits when a field, a count or a comparison settles the value. Define `label(unit)` in Python returning (value, confidence), where a JSON lines record is its dict, a line of text is {"text": the line}, and a card is a dict with its text, kind, question, takeaway, group and groups.
- A prompt fits only when the value takes reading for meaning. A model then reads every unit against your definition, which is slow, so write the definition as one or two sentences that two careful readers would apply the same way.

Give two or a few short values, the positive first and the negative last, such as "match" and "no match". Name the label in a few words taken from the description. Label the records of files unless the description is about cards or report sentences. For records, mark span when the value rests on some words of the record, record when it rests on the whole record, and file when it rests on the whole file.

The analyst asked for: {{description}}

{{records}}

## records

The label would apply to {{paths}}. The first records of {{path}}, each cut at {{cut}} characters:

{{lines}}
