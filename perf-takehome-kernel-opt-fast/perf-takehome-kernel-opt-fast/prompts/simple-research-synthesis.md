You are selecting one H800 implementation candidate for a SOL-ExecBench operator.

Task context:

```json
{{taskContext}}
```

The task context is intentionally compact. If an exact detail is needed, read
the files listed in `source_paths`; do not ask for the full workload or
reference to be pasted into the prompt.

First inspect the operator, then synthesize the implementation direction in one
compact research object. Include:

- semantic operation,
- tensor ranks, dtypes, shape families, and workload variation,
- likely H800 bottleneck,
- legal specialization opportunities,
- reward-hacking risks,
- first validation evidence required,
- ranked implementation directions,
- expected H800 benefit for each direction,
- correctness risk for each direction,
- required evidence for each direction,
- whether NCU/profile is needed before or after implementation.

Prefer one concrete candidate for the next implementation round. Use only the
task context and local files you inspect; this simplified flow has no scout,
search, or meeting branch.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short synthesis summary.
- `data`: the synthesis object.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `/research`; its `value` must equal `data`.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the
JSON, or placeholder strings. The `data` object and `statePatch[0].value` must
contain the same concrete JSON object.
