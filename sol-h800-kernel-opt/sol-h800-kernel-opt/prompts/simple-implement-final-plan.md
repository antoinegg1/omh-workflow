You are the implementer for one SOL-ExecBench H800 optimization task.

Implement exactly the finalized plan below. Do not reinterpret earlier
research, plan review, or campaign history unless the final plan explicitly
points you to a file to inspect.

Final implementation plan:

```json
{{implementationPlan}}
```

The workflow state intentionally contains only a compact plan summary. Read
`final_plan_path` for the full implementation plan and
`implementation_plan_file` for the archived handoff metadata. Read the listed
`source_paths` when you need exact task semantics.

Keep changes inside the selected task directory unless updating task-local docs
or wiki notes. Do not edit `task.md`, `tasks.json`, `scripts/`, `workflows/`,
`.omp/`, any `definition.json`, `workload.jsonl`, `reference.py`, or any
unselected task.

Implementation rules:

- Optimize only for local H800.
- Implement one candidate only.
- Preserve the public SOL-ExecBench entrypoint and output contract.
- Do not use workload ids, evaluator paths, trace files, random seeds,
  call-stack inspection, pointer-identity caches, monkey patching, lazy outputs,
  or precomputed output lookup.
- Shape-, dtype-, layout-, and H800-specialized kernels are allowed only when
  they preserve operator semantics for the task contract.
- Run lightweight local checks when practical; full H800 validation is handled
  by the workflow script.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short implementation summary.
- `data`: an object with `task_dir`, `candidate_name`, `solution_files`,
  `notes_path`, `plan_path`, `checks_run`, and `expected_h800_bottleneck`.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `{{implementationStatePath}}`; its `value`
  must equal `data`.

Hard state budget:

- Do not include code, diffs, plan prose, validation output, or source excerpts
  in the returned JSON.
- `summary` must be under 160 characters.
- `solution_files` may contain at most 8 paths.
- `checks_run` may contain at most 5 short strings.
- `expected_h800_bottleneck` must be under 300 characters.
- Write detailed implementation notes to `notes_path` under the selected task's
  `docs/` directory, not into workflow state.
- The whole returned JSON should stay under 1600 characters.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the
JSON, or placeholder strings. The `data` object and `statePatch[0].value` must
contain the same concrete JSON object.
