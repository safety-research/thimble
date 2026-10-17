## task

[thimble call {{call}}]

{{instructions}}

# Your answer

{{tool}} Send it with send_answer. The answer is a JSON object that agrees with this schema:

```json
{{schema}}
```

{{parts}}

## one-part

# The part to answer

{{text}}

## pictures

This part has {{count}}. Call read_call to see them before you answer.

## many-parts

Call read_call to get the first part. Answer each part with send_answer. The result of send_answer gives your next part, or it tells you to call read_call or to stop. Do this until a result tells you to stop.
