You are the implementer for the perf take-home kernel optimization task.

Implement exactly the finalized plan below. Do not reinterpret earlier
research, plan review, or history unless the final plan explicitly points you to
a file to inspect.

Final implementation plan:

```json
{{implementationPlan}}
```

The workflow state intentionally contains only a compact plan summary. Read
`final_plan_path` for the full implementation plan and
`implementation_plan_file` for the archived handoff metadata. Read the listed
`source_paths` when you need exact semantics (especially `perf_takehome.py` and
the reference/machine model in `problem.py`).

The ONLY file you may edit is `perf_takehome.py` (specifically
`KernelBuilder.build_kernel` and helpers it calls). Do NOT edit `problem.py`,
`tests/`, `tests/frozen_problem.py`, `scripts/`, `workflows/`, or `.omp/`. You
may write implementation notes under `tasks/kernel_opt/docs/`.

Implementation rules:

- Minimize total simulator cycles for do_kernel_test(10, 16, 256).
- Implement one candidate only.
- Preserve kernel semantics: the output values in memory must match the
  reference (`reference_kernel` / `reference_kernel2`) on the frozen simulator.
  Keep the `pause`/yield structure the dev harness expects.
- Do not read reference outputs, hard-code expected results, precompute per-seed
  answers, inspect the call stack, read external files at build time, or
  otherwise bypass the simulator.
- Legitimate optimizations are encouraged: SIMD/VALU vectorization across the
  256 lanes (VLEN=8), packing independent ops to fill VLIW slots (alu=12,
  valu=6, load=2, store=2, flow=1 per cycle), loop unrolling, constant hoisting,
  coalesced/batched loads and stores, and rounds/shape-specialized schedules.
- Respect SCRATCH_SIZE=1536 scratch space.
- Run lightweight local checks when practical; full validation (correctness +
  cycle count on the frozen simulator) is handled by the workflow's
  validateKernel node.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short implementation summary.
- `data`: an object with `task_dir`, `candidate_name`, `solution_files`,
  `notes_path`, `plan_path`, `checks_run`, and `expected_bottleneck`.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `{{implementationStatePath}}`; its `value`
  must equal `data`.

Hard state budget:

- Do not include code, diffs, plan prose, validation output, or source excerpts
  in the returned JSON.
- `summary` must be under 160 characters.
- `solution_files` may contain at most 8 paths (normally just `perf_takehome.py`).
- `checks_run` may contain at most 5 short strings.
- `expected_bottleneck` must be under 300 characters.
- Write detailed implementation notes to `notes_path` under
  `tasks/kernel_opt/docs/`, not into workflow state.
- The whole returned JSON should stay under 1600 characters.

Return raw JSON only. Do not use Markdown fences, comments, prose outside the
JSON, or placeholder strings. The `data` object and `statePatch[0].value` must
contain the same concrete JSON object.
