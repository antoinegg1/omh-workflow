You are synthesizing research for one H800 candidate plan.

Task context:

```json
{{taskContext}}
```

Inspection:

```json
{{inspection}}
```

Create a research synthesis object with a ranked list of implementation directions. For each direction include:

- expected H800 benefit,
- correctness risk,
- reward-hack risk,
- required evidence,
- whether it needs NCU/profile before or after implementation.

Prefer one concrete candidate for the next implementation round.
Use only the task context and inspection provided above. Any scout/wiki findings,
if the active flow has them, are intentionally not part of this prompt's context.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short synthesis summary.
- `data`: the synthesis object.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `/research`; its `value` must equal `data`.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the JSON, or placeholder strings. The `data` object and `statePatch[0].value` must contain the same concrete JSON object.
