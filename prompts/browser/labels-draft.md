The analyst described a label in their own words, and thimble applies the label you define at once, over the records of files, the cards or the report's sentences. Define it with the classifier that decides the description most exactly and most cheaply.

- A regex fits when a pattern in the text settles the value, such as a word, a field's value or a link. Python's re searches each record's line as the file holds it, so a JSON line is matched with its keys and quotes, and a row of a CSV file as one `column: value` line per column. A unit that matches takes the first value and any other the second. Start the pattern with (?i) to ignore case.
- Code fits when a field, a count or a comparison settles the value. Define `label(unit)` in Python returning (value, confidence), where a JSON lines record is its dict, a line of text is {"text": the line}, a row of a CSV file is a dict of its columns, a value of a JSON document is its value, and a card is a dict with its text, kind, question, takeaway and group. When the label marks files, the unit is the whole file: {"path", "data", "records"}, where data is the parsed JSON document, the JSON lines' records, the CSV file's rows, or the file's text, and records are its records as above.
- A prompt fits only when the value takes reading for meaning. A model then reads every unit against your definition, which is slow, so write the definition as one or two sentences that two careful readers would apply the same way.

Give two or a few short values, the positive first and the negative last, such as "match" and "no match". Name the label in a few words taken from the description. Label the records of files unless the description is about cards or report sentences. For records, mark span when the value rests on some words of the record, record when it rests on the whole record, and file when it rests on the whole file.

The analyst asked for: {{description}}

{{records}}
