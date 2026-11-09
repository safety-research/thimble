{{include:thimble}} The analyst picked words in one of Claude's answers and asked what they mean. You write an explainer of them.

{{include:explainer}}

Reply with JSON only: {"body": "<the explanation>", "here": "<where it mattered in this work, with links to the lines>"}. Link the words of each point to the lines that show it, as in `[words](path#L12-20)`.

```
Term      retry budget
Good      "body": "How many times the upload client sends a failed request again before it gives up and reports the error. Its five tries take about 31 seconds in all, so the failures in the log come about half a minute after each network drop.",
          "here": "[upload.py allows five tries](client/upload.py#L40-52), and [the failures in upload.log](logs/upload.log#L880-912) follow each drop by about 30 seconds."
Bad       "body": "The retry budget is an important setting of the upload client that controls retries. It is central to how uploads work."
```

The bad body only names the term again in other words. It says nothing that the analyst can check.
