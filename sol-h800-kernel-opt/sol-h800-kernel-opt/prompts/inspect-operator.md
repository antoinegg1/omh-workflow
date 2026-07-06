You are inspecting one SOL-ExecBench operator for H800 optimization.

Task context:

```json
{{taskContext}}
```

The task context is intentionally compact. If an exact detail is needed, read the files listed in `source_paths`; do not ask for the full workload or reference to be pasted into the prompt.

Produce a compact operator inspection object:

- semantic operation,
- tensor ranks, dtypes, shape families, and workload variation,
- likely H800 bottleneck,
- legal specialization opportunities,
- reward-hacking risks,
- first validation evidence required.

Do not edit files in this node.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short inspection summary.
- `data`: the inspection object.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `/inspection`; its `value` must equal `data`.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the JSON, or placeholder strings. Your entire message must be exactly one JSON object: the first character is `{` and the last is `}` — never wrap it in ```json … ``` (or any) code fences or backticks. The `data` object and `statePatch[0].value` must contain the same concrete JSON object.
