You are the implementer for the perf take-home kernel optimization task. You both
DECIDE the next optimization and IMPLEMENT it in one step — there is no separate
planner. Work directly; edit `perf_takehome.py`.

Task context (includes the current best cycles, candidate history, and — under
`planner_feedback` — the previous review's compliance note and its concrete
`next_experiments` / `must_do_next` optimization suggestions):

```json
{{taskContext}}
```

Your job this round:

1. Read `perf_takehome.py` (especially `KernelBuilder.build_kernel` and its
   helpers) to see the current kernel. Read `problem.py` for exact machine model
   and reference semantics when you need them. Read `taskContext.planner_feedback`
   — if the last review proposed a specific optimization (`must_do_next` /
   `next_experiments`), prioritize implementing THAT unless you have a clearly
   better, concrete idea.
2. Pick ONE concrete optimization that should reduce total simulator cycles for
   `do_kernel_test(10, 16, 256)`, and implement it now by editing
   `perf_takehome.py`.

The ONLY file you may edit is `perf_takehome.py` (specifically
`KernelBuilder.build_kernel` and helpers it calls). Do NOT edit `problem.py`,
`tests/`, `tests/frozen_problem.py`, `scripts/`, `workflows/`, or `.omp/`. You
may write implementation notes under `tasks/kernel_opt/docs/`.

If you write throwaway experiment/probe scripts to measure candidate variants,
put them under `/tmp/` (e.g. `/tmp/probe_xxx.py`), NEVER in the repository
working directory. Stray experiment files committed to the repo root can trip
the protected-files guard; keep the repo clean — only `perf_takehome.py` and
`tasks/kernel_opt/docs/` notes should change.

Implementation rules:

- Minimize total simulator cycles for `do_kernel_test(10, 16, 256)`.
- Implement one candidate only (one coherent change per round).
- Preserve kernel semantics: the output values in memory must match the
  reference (`reference_kernel` / `reference_kernel2`) on the frozen simulator.
  Keep the `pause`/yield structure the dev harness expects.
- Do not read reference outputs, hard-code expected results, precompute per-seed
  answers, inspect the call stack, read external files at build time, or
  otherwise bypass the simulator. Specializing to the FIXED declared dimensions
  (forest_height=10, rounds=16, batch_size=256, tree size) and the fixed hash
  constants is allowed; branching on runtime memory/tensor CONTENTS is not.
- Legitimate optimizations are encouraged: SIMD/VALU vectorization across the
  256 lanes (VLEN=8), packing independent ops to fill VLIW slots (alu=12,
  valu=6, load=2, store=2, flow=1 per cycle), loop unrolling, constant hoisting,
  coalesced/batched loads and stores, list-scheduling the dependence DAG, and
  rounds/shape-specialized schedules.
- Respect SCRATCH_SIZE=1536 scratch space.
- Run lightweight local checks when practical; full validation (correctness +
  cycle count on the frozen simulator) is handled by the workflow's
  validateKernel node.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short implementation summary (what optimization you applied).
- `data`: an object with `task_dir`, `candidate_name`, `solution_files`,
  `notes_path`, `checks_run`, and `expected_bottleneck`.
- `statePatch`: a JSON array (not a single object) containing one `set` operation
  writing `{{implementationStatePath}}`; its `value` must equal `data`.

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
JSON, or placeholder strings. Your entire message must be exactly one JSON object: the first character is `{` and the last is `}` — never wrap it in ```json … ``` (or any) code fences or backticks. The `data` object and `statePatch[0].value` must
contain the same concrete JSON object.
