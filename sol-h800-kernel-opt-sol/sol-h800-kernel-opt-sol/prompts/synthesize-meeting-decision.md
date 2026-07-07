You are the coordinator. Synthesize the model meeting into one binding decision.

Meeting state:

```json
{{meeting}}
```

Choose exactly one next action:

- continue current candidate,
- revise current candidate,
- profile,
- dispatch scouts,
- switch task,
- create/update a project skill,
- finalize if complete.

If creating a skill, include `/skillProposal` compatible fields: `name`, `description`, and `body`.

Write the meeting decision to `wiki/meetings/` and create a decision object with selected action, owner, required evidence, next validation command, and decision path.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short binding decision.
- `data`: the decision object.
- `statePatch`: a JSON array (not a single object). Always include one `set` operation writing `/meeting/decision`; its `value` must equal `data`. If creating or updating a skill, also include a second `set` operation writing `/skillProposal` with concrete `name`, `description`, and `body` string fields.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the JSON, or placeholder strings. Your entire message must be exactly one JSON object: the first character is `{` and the last is `}` — never wrap it in ```json … ``` (or any) code fences or backticks. The `data` object and the `/meeting/decision` patch value must contain the same concrete JSON object.
