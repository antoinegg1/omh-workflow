You are preparing a model meeting.

Meeting gate:

```json
{{meeting}}
```

Task context:

```json
{{taskContext}}
```

Validation:

```json
{{validation}}
```

Write a meeting brief under `wiki/meetings/` with:

- topic,
- task and candidate,
- evidence,
- decision needed,
- constraints,
- exact questions each model should answer.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short meeting topic.
- `data`: an object with `topic`, `brief_path`, `task_dir`, `candidate`, and `questions`.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `/meeting/brief`; its `value` must equal `data`.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the JSON, or placeholder strings. Your entire message must be exactly one JSON object: the first character is `{` and the last is `}` — never wrap it in ```json … ``` (or any) code fences or backticks. The `data` object and `statePatch[0].value` must contain the same concrete JSON object.
