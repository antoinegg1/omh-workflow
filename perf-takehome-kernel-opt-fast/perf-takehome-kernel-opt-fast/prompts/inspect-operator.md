You are inspecting the perf take-home kernel for cycle optimization.

Task context:

```json
{{taskContext}}
```

The task context is intentionally compact. If an exact detail is needed, read the files listed in `source_paths` (the scored kernel `perf_takehome.py` and the reference/machine model `problem.py`); do not ask for the full source to be pasted into the prompt.

Produce a compact inspection object:

- semantic operation (the batched tree-traversal hash kernel),
- the machine model that matters (per-cycle slot limits alu=12/valu=6/load=2/store=2/flow=1, VLEN=8, N_CORES=1, SCRATCH_SIZE=1536; one cycle per bundle with a non-debug op),
- likely cycle bottleneck (e.g. scalar per-lane work not vectorized, under-filled VLIW bundles, serial dependency chains in the hash),
- legal optimization opportunities (SIMD/VALU vectorization across 256 lanes, VLIW slot packing, unrolling, constant hoisting, coalesced loads/stores),
- reward-hacking risks,
- first validation evidence required (correctness + cycle count on the frozen simulator).

Do not edit files in this node.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short inspection summary.
- `data`: the inspection object.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `/inspection`; its `value` must equal `data`.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the JSON, or placeholder strings. Your entire message must be exactly one JSON object: the first character is `{` and the last is `}` — never wrap it in ```json … ``` (or any) code fences or backticks. The `data` object and `statePatch[0].value` must contain the same concrete JSON object.
