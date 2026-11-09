## draft

The analyst described a label in their own words. thimble applies your label at once. Define the label with the classifier that decides the description most exactly and most cheaply.

- A regex fits when a pattern in the text settles the value, for example a word, a field's value or a link. Python's re searches each record's line as the file holds it. So a JSON line is matched with its keys and quotes, and a row of a database or a CSV file is matched as one `column: value` line per column. A unit that matches takes the first value, and any other unit takes the second. Start the pattern with (?i) to ignore case.
- Code fits when a field, a count or a comparison settles the value. Define `label(unit)` in Python, returning (value, confidence). The unit depends on what the label reads:
  - a JSON lines record is its dict
  - a line of text is {"text": the line}
  - a row of a database or a CSV file is a dict of its columns
  - a record of a JSON document is its value
  - a page of a PDF is {"page", "text"}
  - a card is a dict with its text, kind, question, takeaway, group and groups

  When the label marks files, the unit is the whole file: {"path", "data", "records"}. `data` is the parsed JSON document, the JSON lines' records, the CSV file's or database's rows, the PDF's pages, or the file's text. `records` are the file's records, as above.
- A prompt fits only when the value takes reading for meaning. A model then reads every unit against your definition, and that is slow. So write the definition as one or two sentences that two careful readers would apply the same way.

Give two or a few short values, with the positive value first and the negative value last, for example "match" and "no match". Name the label in a few words taken from the description. Label the records of files, unless the description is about cards or report sentences. For records, mark span when the value rests on some words of the record. Mark record when it rests on the whole record, and file when it rests on the whole file.

The analyst asked for: {{description}}

{{records}}

## records

The label would apply to {{paths}}. The first records of {{path}}, each cut at {{cut}} characters:

{{lines}}
